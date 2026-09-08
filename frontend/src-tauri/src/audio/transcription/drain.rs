// audio/transcription/drain.rs
//
// Pure policy for the recording stop tail's "drain the transcription queue"
// wait. Kept free of tokio/tauri so it can be unit tested.
//
// Background: the stop tail used to wait on the transcription task with a flat
// 10-minute timeout. When the engine was held by a batch job (audio import /
// retranscription) the queue made no progress, `is_recording` stayed true for
// minutes and the UI hung. The policy below waits as long as chunks keep
// completing, but gives up when nothing has happened for `stall_timeout`, or
// when the absolute `hard_cap` is hit.

use std::time::Duration;

/// Tunables for the drain wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrainPolicy {
    /// Give up if no chunk completes within this window.
    pub stall_timeout: Duration,
    /// Absolute upper bound for the whole drain, even if progress is being made.
    pub hard_cap: Duration,
}

impl DrainPolicy {
    /// Production defaults: a single chunk normally transcribes in a few seconds,
    /// so two minutes without any completion means the engine is wedged
    /// (busy elsewhere / contended); fifteen minutes bounds the pathological
    /// "huge backlog on a slow CPU" case so the tail always finishes.
    pub const fn default_live() -> Self {
        DrainPolicy {
            stall_timeout: Duration::from_secs(120),
            hard_cap: Duration::from_secs(15 * 60),
        }
    }

    /// The engine is known to be held by a batch job (audio import /
    /// retranscription) at stop time. Live chunks will not move until that
    /// job's current segment finishes, and the whole backlog may never drain
    /// before the job ends, so give up much sooner: the audio file and the
    /// meeting row are what the user is waiting for.
    pub const fn contended() -> Self {
        DrainPolicy {
            stall_timeout: Duration::from_secs(30),
            hard_cap: Duration::from_secs(5 * 60),
        }
    }
}

/// What the stop tail should do after each poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainDecision {
    /// Queue drained (or the task finished) - proceed normally.
    Complete,
    /// Still making progress (or under the stall budget) - poll again.
    KeepWaiting,
    /// No completion for `stall_timeout` - abandon remaining chunks.
    Stalled,
    /// `hard_cap` elapsed - abandon remaining chunks.
    HardCapReached,
}

impl DrainDecision {
    pub fn is_abandoned(self) -> bool {
        matches!(self, DrainDecision::Stalled | DrainDecision::HardCapReached)
    }
}

/// One observation of the drain state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrainObservation {
    /// Time since the drain wait started.
    pub elapsed: Duration,
    /// Time since the last chunk was dispatched or completed.
    pub since_last_activity: Duration,
    /// Chunks handed to the workers so far.
    pub chunks_queued: u64,
    /// Chunks the workers have finished (transcribed, skipped or dropped).
    pub chunks_completed: u64,
    /// The transcription task itself has exited.
    pub task_finished: bool,
}

/// Decide what to do next. Order matters: a finished task or empty queue is
/// always `Complete`; the hard cap wins over the stall check so the absolute
/// bound is honoured even if activity keeps ticking.
pub fn evaluate_drain(obs: &DrainObservation, policy: &DrainPolicy) -> DrainDecision {
    if obs.task_finished || obs.chunks_completed >= obs.chunks_queued {
        return DrainDecision::Complete;
    }
    if obs.elapsed >= policy.hard_cap {
        return DrainDecision::HardCapReached;
    }
    if obs.since_last_activity >= policy.stall_timeout {
        return DrainDecision::Stalled;
    }
    DrainDecision::KeepWaiting
}

/// Human-readable progress line for the shutdown progress event.
pub fn describe_drain(obs: &DrainObservation) -> String {
    let pending = obs.chunks_queued.saturating_sub(obs.chunks_completed);
    format!(
        "Processing transcripts... {} of {} chunks done, {} pending ({}s elapsed)",
        obs.chunks_completed,
        obs.chunks_queued,
        pending,
        obs.elapsed.as_secs()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> DrainPolicy {
        DrainPolicy {
            stall_timeout: Duration::from_secs(10),
            hard_cap: Duration::from_secs(60),
        }
    }

    fn obs(elapsed: u64, idle: u64, queued: u64, completed: u64, finished: bool) -> DrainObservation {
        DrainObservation {
            elapsed: Duration::from_secs(elapsed),
            since_last_activity: Duration::from_secs(idle),
            chunks_queued: queued,
            chunks_completed: completed,
            task_finished: finished,
        }
    }

    #[test]
    fn finished_task_is_complete_regardless_of_counters() {
        assert_eq!(
            evaluate_drain(&obs(5, 0, 10, 3, true), &policy()),
            DrainDecision::Complete
        );
    }

    #[test]
    fn empty_queue_is_complete() {
        assert_eq!(
            evaluate_drain(&obs(1, 0, 4, 4, false), &policy()),
            DrainDecision::Complete
        );
        assert_eq!(
            evaluate_drain(&obs(1, 0, 0, 0, false), &policy()),
            DrainDecision::Complete
        );
    }

    #[test]
    fn keeps_waiting_while_progress_is_recent() {
        // 30s elapsed but a chunk completed 2s ago -> not stalled, under cap.
        assert_eq!(
            evaluate_drain(&obs(30, 2, 10, 6, false), &policy()),
            DrainDecision::KeepWaiting
        );
    }

    #[test]
    fn stalls_when_no_activity_for_the_stall_window() {
        // Engine busy elsewhere: nothing completed for 10s.
        assert_eq!(
            evaluate_drain(&obs(12, 10, 10, 6, false), &policy()),
            DrainDecision::Stalled
        );
    }

    #[test]
    fn hard_cap_wins_even_with_recent_activity() {
        assert_eq!(
            evaluate_drain(&obs(60, 1, 100, 50, false), &policy()),
            DrainDecision::HardCapReached
        );
    }

    #[test]
    fn hard_cap_wins_over_stall() {
        assert_eq!(
            evaluate_drain(&obs(60, 30, 100, 50, false), &policy()),
            DrainDecision::HardCapReached
        );
    }

    #[test]
    fn abandoned_helper() {
        assert!(DrainDecision::Stalled.is_abandoned());
        assert!(DrainDecision::HardCapReached.is_abandoned());
        assert!(!DrainDecision::KeepWaiting.is_abandoned());
        assert!(!DrainDecision::Complete.is_abandoned());
    }

    #[test]
    fn default_policy_is_bounded_and_generous() {
        let p = DrainPolicy::default_live();
        assert!(p.stall_timeout >= Duration::from_secs(60));
        assert!(p.hard_cap > p.stall_timeout);
        assert!(p.hard_cap <= Duration::from_secs(20 * 60));
    }

    #[test]
    fn contended_policy_gives_up_sooner_than_default() {
        let live = DrainPolicy::default_live();
        let contended = DrainPolicy::contended();
        assert!(contended.stall_timeout < live.stall_timeout);
        assert!(contended.hard_cap < live.hard_cap);
        assert!(contended.hard_cap > contended.stall_timeout);
        // 35s without a completion while an import holds the engine -> stalled.
        assert_eq!(
            evaluate_drain(&obs(35, 35, 8, 2, false), &contended),
            DrainDecision::Stalled
        );
        // The same observation is still "keep waiting" under the live policy.
        assert_eq!(
            evaluate_drain(&obs(35, 35, 8, 2, false), &live),
            DrainDecision::KeepWaiting
        );
    }

    #[test]
    fn describe_mentions_pending_count() {
        let text = describe_drain(&obs(7, 1, 5, 2, false));
        assert!(text.contains("2 of 5"));
        assert!(text.contains("3 pending"));
        assert!(text.contains("7s"));
    }
}
