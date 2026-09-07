//! In-memory map of import jobs started through the sync API.
//!
//! The import pipeline only creates the meeting id when it finishes, so an
//! upload returns a job id and the client polls `/meetings/{job_id}/status`
//! until the job carries a `meeting_id`. Progress is fed from the
//! `import-progress` events the pipeline already emits; only one import can
//! run at a time (guarded by the pipeline), so events always belong to the
//! active job.

use chrono::{DateTime, Duration, Utc};
use log::warn;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use uuid::Uuid;

/// Keep finished jobs around for this long so clients can still poll them.
const JOB_RETENTION_HOURS: i64 = 24;
/// Hard cap on remembered jobs.
const MAX_JOBS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Processing,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportJob {
    pub id: String,
    pub title: String,
    pub status: JobStatus,
    pub progress: u32,
    pub message: String,
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Payload shape of the `import-progress` event (see `audio::import::ImportProgress`).
#[derive(Debug, Deserialize)]
struct ProgressPayload {
    stage: String,
    progress_percentage: u32,
    message: String,
}

#[derive(Default)]
struct JobsInner {
    jobs: HashMap<String, ImportJob>,
    active: Option<String>,
}

#[derive(Default)]
pub struct ImportJobs {
    inner: Mutex<JobsInner>,
}

impl ImportJobs {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, JobsInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Registers a new job in the `processing` state and returns it.
    pub fn create(&self, title: &str) -> ImportJob {
        let now = Utc::now();
        let job = ImportJob {
            id: format!("job-{}", Uuid::new_v4()),
            title: title.to_string(),
            status: JobStatus::Processing,
            progress: 0,
            message: "Queued".to_string(),
            stage: None,
            meeting_id: None,
            created_at: now,
            updated_at: now,
        };
        let mut inner = self.lock();
        Self::prune(&mut inner);
        inner.jobs.insert(job.id.clone(), job.clone());
        job
    }

    /// Marks the job as the one currently driving the import pipeline.
    pub fn set_active(&self, job_id: &str) {
        let mut inner = self.lock();
        inner.active = Some(job_id.to_string());
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.message = "Starting import".to_string();
            job.updated_at = Utc::now();
        }
    }

    pub fn complete(&self, job_id: &str, meeting_id: String) {
        let mut inner = self.lock();
        if inner.active.as_deref() == Some(job_id) {
            inner.active = None;
        }
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.status = JobStatus::Ready;
            job.progress = 100;
            job.message = "Import complete".to_string();
            job.stage = Some("done".to_string());
            job.meeting_id = Some(meeting_id);
            job.updated_at = Utc::now();
        }
    }

    pub fn fail(&self, job_id: &str, error: String) {
        let mut inner = self.lock();
        if inner.active.as_deref() == Some(job_id) {
            inner.active = None;
        }
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.status = JobStatus::Error;
            job.message = error;
            job.stage = Some("error".to_string());
            job.updated_at = Utc::now();
        }
    }

    pub fn get(&self, job_id: &str) -> Option<ImportJob> {
        self.lock().jobs.get(job_id).cloned()
    }

    /// Applies an `import-progress` event payload to the active job.
    pub fn handle_progress_event(&self, payload: &str) {
        let progress: ProgressPayload = match serde_json::from_str(payload) {
            Ok(progress) => progress,
            Err(e) => {
                warn!("[sync] unreadable import-progress payload: {}", e);
                return;
            }
        };
        self.update_progress(&progress.stage, progress.progress_percentage, &progress.message);
    }

    pub fn update_progress(&self, stage: &str, progress: u32, message: &str) {
        let mut inner = self.lock();
        let Some(active) = inner.active.clone() else {
            return;
        };
        if let Some(job) = inner.jobs.get_mut(&active) {
            if job.status == JobStatus::Processing {
                job.progress = progress.min(99);
                job.message = message.to_string();
                job.stage = Some(stage.to_string());
                job.updated_at = Utc::now();
            }
        }
    }

    fn prune(inner: &mut JobsInner) {
        let cutoff = Utc::now() - Duration::hours(JOB_RETENTION_HOURS);
        let active = inner.active.clone();
        inner.jobs.retain(|id, job| {
            job.status == JobStatus::Processing
                || active.as_deref() == Some(id.as_str())
                || job.updated_at > cutoff
        });
        if inner.jobs.len() > MAX_JOBS {
            let mut finished: Vec<(String, DateTime<Utc>)> = inner
                .jobs
                .values()
                .filter(|job| job.status != JobStatus::Processing)
                .map(|job| (job.id.clone(), job.updated_at))
                .collect();
            finished.sort_by_key(|(_, updated)| *updated);
            let excess = inner.jobs.len() - MAX_JOBS;
            for (id, _) in finished.into_iter().take(excess) {
                inner.jobs.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_events_only_touch_the_active_job() {
        let jobs = ImportJobs::new();
        let idle = jobs.create("idle");
        let active = jobs.create("active");
        jobs.set_active(&active.id);
        jobs.handle_progress_event(
            r#"{"stage":"transcribing","progress_percentage":42,"message":"Transcribing..."}"#,
        );
        let active = jobs.get(&active.id).unwrap();
        assert_eq!(active.progress, 42);
        assert_eq!(active.stage.as_deref(), Some("transcribing"));
        let idle = jobs.get(&idle.id).unwrap();
        assert_eq!(idle.progress, 0);
    }

    #[test]
    fn completion_and_failure_finalise_jobs() {
        let jobs = ImportJobs::new();
        let ok = jobs.create("ok");
        jobs.set_active(&ok.id);
        jobs.complete(&ok.id, "meeting-1".to_string());
        let ok = jobs.get(&ok.id).unwrap();
        assert_eq!(ok.status, JobStatus::Ready);
        assert_eq!(ok.meeting_id.as_deref(), Some("meeting-1"));
        assert_eq!(ok.progress, 100);

        let failed = jobs.create("failed");
        jobs.set_active(&failed.id);
        jobs.fail(&failed.id, "boom".to_string());
        let failed = jobs.get(&failed.id).unwrap();
        assert_eq!(failed.status, JobStatus::Error);
        assert_eq!(failed.message, "boom");
        // Progress after completion must not resurrect the job.
        jobs.update_progress("vad", 10, "late");
        assert_eq!(jobs.get(&failed.id).unwrap().status, JobStatus::Error);
    }

    #[test]
    fn malformed_payloads_are_ignored() {
        let jobs = ImportJobs::new();
        let job = jobs.create("x");
        jobs.set_active(&job.id);
        jobs.handle_progress_event("not json");
        assert_eq!(jobs.get(&job.id).unwrap().progress, 0);
    }
}
