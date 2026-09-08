use crate::api::TranscriptSegment;
use anyhow::Result;
use log::{debug, info};
use once_cell::sync::Lazy;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

static ENGINE_LIFECYCLE_LOCK: Lazy<Arc<AsyncMutex<()>>> =
    Lazy::new(|| Arc::new(AsyncMutex::new(())));

pub(crate) async fn acquire_engine_lifecycle_lock() -> OwnedMutexGuard<()> {
    ENGINE_LIFECYCLE_LOCK.clone().lock_owned().await
}

/// Unload the transcription engine after a batch job (import or retranscription).
/// Skips unloading if a live recording is currently in progress, since recording
/// uses the same global engine instances.
pub(crate) async fn unload_engine_after_batch(use_parakeet: bool) {
    let _engine_lifecycle_guard = acquire_engine_lifecycle_lock().await;

    if crate::audio::recording_commands::is_recording().await {
        log::info!("Skipping model unload after batch: recording in progress");
        return;
    }

    if use_parakeet {
        use crate::parakeet_engine::commands::PARAKEET_ENGINE;
        let engine = {
            let guard = PARAKEET_ENGINE.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().cloned()
        };
        if let Some(e) = engine {
            e.unload_model().await;
        }
    } else {
        use crate::whisper_engine::commands::WHISPER_ENGINE;
        let engine = {
            let guard = WHISPER_ENGINE.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().cloned()
        };
        if let Some(e) = engine {
            e.unload_model().await;
        }
    }
}

/// Create transcript segments from transcription results.
/// Each tuple is (text, start_ms, end_ms) from VAD timestamps.
pub(crate) fn create_transcript_segments(transcripts: &[(String, f64, f64)]) -> Vec<TranscriptSegment> {
    transcripts
        .iter()
        .map(|(text, start_ms, end_ms)| {
            let start_seconds = start_ms / 1000.0;
            let end_seconds = end_ms / 1000.0;
            let duration = end_seconds - start_seconds;

            TranscriptSegment {
                id: format!("transcript-{}", Uuid::new_v4()),
                text: text.trim().to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                audio_start_time: Some(start_seconds),
                audio_end_time: Some(end_seconds),
                duration: Some(duration),
            }
        })
        .collect()
}

/// Write transcripts.json to a meeting folder (atomic write with temp file)
pub(crate) fn write_transcripts_json(folder: &Path, segments: &[TranscriptSegment]) -> Result<()> {
    let transcript_path = folder.join("transcripts.json");
    let temp_path = folder.join(".transcripts.json.tmp");

    let json = serde_json::json!({
        "version": "1.0",
        "last_updated": chrono::Utc::now().to_rfc3339(),
        "total_segments": segments.len(),
        "segments": segments.iter().enumerate().map(|(i, s)| {
            serde_json::json!({
                "id": s.id,
                "text": s.text,
                "timestamp": s.timestamp,
                "audio_start_time": s.audio_start_time,
                "audio_end_time": s.audio_end_time,
                "duration": s.duration,
                "sequence_id": i
            })
        }).collect::<Vec<_>>()
    });

    let json_string = serde_json::to_string_pretty(&json)?;
    std::fs::write(&temp_path, &json_string)?;
    std::fs::rename(&temp_path, &transcript_path)?;

    info!(
        "Wrote transcripts.json with {} segments to {}",
        segments.len(),
        transcript_path.display()
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Segment splitting for batch transcription (import / retranscription)
// ---------------------------------------------------------------------------

/// Sample rate of everything that reaches Whisper/Parakeet.
pub(crate) const BATCH_SAMPLE_RATE: usize = 16000;

/// Longest piece handed to the engine when the language is forced. Whisper's
/// window is 30s; 25s leaves headroom for the silence search overshoot.
pub(crate) const FORCED_LANGUAGE_MAX_SEGMENT_SAMPLES: usize = 25 * BATCH_SAMPLE_RATE;

/// With automatic language detection Whisper picks ONE language per call, so a
/// sentence in another language inside a long segment is dropped or garbled.
/// Shorter pieces cut at silence (sentence boundaries) give each sentence its
/// own detection. Target ~8s, never longer than ~12s, never shorter than ~4s
/// (below that detection itself becomes unreliable).
pub(crate) const AUTO_LANGUAGE_TARGET_SEGMENT_SAMPLES: usize = 8 * BATCH_SAMPLE_RATE;
pub(crate) const AUTO_LANGUAGE_MAX_SEGMENT_SAMPLES: usize = 12 * BATCH_SAMPLE_RATE;
pub(crate) const AUTO_LANGUAGE_MIN_SEGMENT_SAMPLES: usize = 4 * BATCH_SAMPLE_RATE;

/// True when the caller did not force a language, i.e. Whisper will detect it
/// per call ("auto-translate" also detects, then translates).
pub(crate) fn is_auto_language(language: Option<&str>) -> bool {
    match language.map(str::trim) {
        None | Some("") | Some("auto") | Some("auto-translate") => true,
        Some(_) => false,
    }
}

/// How a VAD speech segment is cut into engine-sized pieces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SegmentSplitPolicy {
    /// Pieces at or below this length are left whole.
    pub max_samples: usize,
    /// Preferred piece length; the silence search is centred on it.
    pub target_samples: usize,
    /// Never cut earlier than this into a piece.
    pub min_samples: usize,
    /// How far past `target` the silence search may look (forced mode overshoots
    /// by up to 3s; auto mode is capped at `max`).
    pub search_after_target: usize,
    /// Absolute longest piece, including the 1s no-silence overshoot.
    pub hard_cap_samples: usize,
}

impl SegmentSplitPolicy {
    /// Legacy behaviour: cut near `max_samples`, searching +/-3s around it.
    pub(crate) fn forced(max_samples: usize) -> Self {
        SegmentSplitPolicy {
            max_samples,
            target_samples: max_samples,
            min_samples: max_samples.saturating_sub(3 * BATCH_SAMPLE_RATE).max(BATCH_SAMPLE_RATE),
            search_after_target: 3 * BATCH_SAMPLE_RATE,
            // legacy: split point up to +3s past max, then +1s overlap
            hard_cap_samples: max_samples + 4 * BATCH_SAMPLE_RATE,
        }
    }

    /// Short pieces so each gets its own language detection.
    pub(crate) fn auto_language() -> Self {
        SegmentSplitPolicy {
            max_samples: AUTO_LANGUAGE_MAX_SEGMENT_SAMPLES,
            target_samples: AUTO_LANGUAGE_TARGET_SEGMENT_SAMPLES,
            min_samples: AUTO_LANGUAGE_MIN_SEGMENT_SAMPLES,
            search_after_target: AUTO_LANGUAGE_MAX_SEGMENT_SAMPLES - AUTO_LANGUAGE_TARGET_SEGMENT_SAMPLES,
            hard_cap_samples: AUTO_LANGUAGE_MAX_SEGMENT_SAMPLES,
        }
    }
}

/// Pick the split policy for a batch job. Parakeet has no per-call language
/// detection, so it keeps the long pieces regardless of the language setting.
pub(crate) fn segment_split_policy(language: Option<&str>, use_parakeet: bool) -> SegmentSplitPolicy {
    if !use_parakeet && is_auto_language(language) {
        SegmentSplitPolicy::auto_language()
    } else {
        SegmentSplitPolicy::forced(FORCED_LANGUAGE_MAX_SEGMENT_SAMPLES)
    }
}

/// Split a long speech segment at the lowest-energy (silence) point near the target size.
///
/// Legacy entry point (forced-language behaviour): scans for 100ms windows with
/// minimal RMS energy within +/-3 seconds of each target split point. If no
/// clear silence is found, falls back to a 1-second overlap split to avoid
/// cutting words at boundaries.
///
/// Production callers go through `segment_split_policy` +
/// `split_segment_with_policy`; this wrapper is kept for the legacy tests.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn split_segment_at_silence(
    segment: &crate::audio::vad::SpeechSegment,
    max_samples: usize,
) -> Vec<crate::audio::vad::SpeechSegment> {
    split_segment_with_policy(segment, &SegmentSplitPolicy::forced(max_samples))
}

/// Split a speech segment into engine-sized pieces according to `policy`.
///
/// For each piece the search window is `[pos + min, pos + target + search_after_target]`
/// (clamped to the segment). The lowest-RMS 100ms window wins; among windows
/// that are actually silent the one closest to `target` is preferred, so cuts
/// land on sentence boundaries near the target length rather than at the
/// quietest point of a long run. If nothing in the window is silent, the piece
/// is extended by up to 1s past the quietest point (but never past
/// `pos + hard_cap_samples`) so a word is not cut mid-way. Timestamps are
/// interpolated linearly from the segment's own start/end so pieces stay
/// contiguous and cover the original exactly.
pub(crate) fn split_segment_with_policy(
    segment: &crate::audio::vad::SpeechSegment,
    policy: &SegmentSplitPolicy,
) -> Vec<crate::audio::vad::SpeechSegment> {
    // 100ms window for energy measurement (1600 samples at 16kHz)
    const ENERGY_WINDOW: usize = BATCH_SAMPLE_RATE / 10;
    // Step by 10ms (160 samples) for efficiency
    const ENERGY_STEP: usize = BATCH_SAMPLE_RATE / 100;
    // RMS threshold below which we consider a window "silent"
    const SILENCE_RMS_THRESHOLD: f32 = 0.02;
    // Overlap to use when no silence boundary is found (1 second)
    const FALLBACK_OVERLAP: usize = BATCH_SAMPLE_RATE;

    let total = segment.samples.len();
    if total <= policy.max_samples || total == 0 {
        return vec![segment.clone()];
    }

    let ms_per_sample =
        (segment.end_timestamp_ms - segment.start_timestamp_ms) / segment.samples.len() as f64;
    let mut result = Vec::new();
    let mut pos = 0usize;

    while pos < total {
        let remaining = total - pos;
        if remaining <= policy.max_samples {
            // Last chunk - take everything remaining
            result.push(crate::audio::vad::SpeechSegment {
                samples: segment.samples[pos..].to_vec(),
                start_timestamp_ms: segment.start_timestamp_ms + (pos as f64 * ms_per_sample),
                end_timestamp_ms: segment.end_timestamp_ms,
                confidence: segment.confidence,
            });
            break;
        }

        let target = pos + policy.target_samples;
        let search_start = pos + policy.min_samples.max(ENERGY_WINDOW);
        let search_end = (target + policy.search_after_target).min(total.saturating_sub(ENERGY_WINDOW));

        // Find the best 100ms window in the search range. Score: any silent
        // window beats any non-silent one; among silent windows the one nearest
        // the target wins; among non-silent ones the quietest wins, with a mild
        // penalty for straying far from the target so pieces don't collapse to
        // the minimum length when the whole range is equally loud.
        let mut best_split = target.min(total); // fallback: exact target
        let mut best_rms = f32::MAX;
        let mut best_score = f32::MAX;

        if search_start + ENERGY_WINDOW <= search_end {
            let mut idx = search_start;
            while idx + ENERGY_WINDOW <= search_end {
                let window = &segment.samples[idx..idx + ENERGY_WINDOW];
                let rms = (window.iter().map(|s| s * s).sum::<f32>() / ENERGY_WINDOW as f32).sqrt();
                let centre = idx + ENERGY_WINDOW / 2;
                let distance = centre.abs_diff(target) as f32 / policy.target_samples.max(1) as f32;
                let score = if rms <= SILENCE_RMS_THRESHOLD {
                    distance
                } else {
                    1.0e6 + rms * (1.0 + 0.25 * distance)
                };
                if score < best_score {
                    best_score = score;
                    best_rms = rms;
                    best_split = centre;
                }
                idx += ENERGY_STEP;
            }
        }

        let split_at = best_split;
        let chunk_end = if best_rms > SILENCE_RMS_THRESHOLD {
            debug!(
                "No silence found near target (best RMS={:.4}), splitting with overlap at sample {}",
                best_rms, split_at
            );
            (split_at + FALLBACK_OVERLAP).min(pos + policy.hard_cap_samples).min(total)
        } else {
            debug!(
                "Splitting at silence boundary: sample {} (RMS={:.4})",
                split_at, best_rms
            );
            split_at
        };
        // Never produce an empty or non-advancing piece.
        let chunk_end = chunk_end.max(pos + 1).min(total);

        result.push(crate::audio::vad::SpeechSegment {
            samples: segment.samples[pos..chunk_end].to_vec(),
            start_timestamp_ms: segment.start_timestamp_ms + (pos as f64 * ms_per_sample),
            end_timestamp_ms: segment.start_timestamp_ms + (chunk_end as f64 * ms_per_sample),
            confidence: segment.confidence,
        });

        // Advance position to where the current chunk actually ends
        // to avoid transcribing the overlap region twice
        pos = chunk_end;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::vad::SpeechSegment;

    /// Synthetic "speech": a low tone bursts separated by true silence. `bursts`
    /// is a list of (start_s, end_s) speech spans inside a `total_s` segment.
    fn synthetic_segment(total_s: f64, bursts: &[(f64, f64)], start_ms: f64) -> SpeechSegment {
        let total = (total_s * BATCH_SAMPLE_RATE as f64) as usize;
        let mut samples = vec![0.0f32; total];
        for i in 0..total {
            let t = i as f64 / BATCH_SAMPLE_RATE as f64;
            if bursts.iter().any(|(a, b)| t >= *a && t < *b) {
                samples[i] = 0.3 * (2.0 * std::f64::consts::PI * 220.0 * t).sin() as f32;
            }
        }
        SpeechSegment {
            samples,
            start_timestamp_ms: start_ms,
            end_timestamp_ms: start_ms + total_s * 1000.0,
            confidence: 0.9,
        }
    }

    fn assert_contiguous_cover(original: &SpeechSegment, pieces: &[SpeechSegment]) {
        let joined: Vec<f32> = pieces.iter().flat_map(|p| p.samples.iter().copied()).collect();
        assert_eq!(joined.len(), original.samples.len(), "pieces must cover every sample exactly once");
        assert_eq!(joined, original.samples);
        assert!((pieces[0].start_timestamp_ms - original.start_timestamp_ms).abs() < 1e-6);
        assert!((pieces.last().unwrap().end_timestamp_ms - original.end_timestamp_ms).abs() < 1e-6);
        for pair in pieces.windows(2) {
            assert!(
                (pair[0].end_timestamp_ms - pair[1].start_timestamp_ms).abs() < 1e-6,
                "pieces must be contiguous in time"
            );
        }
        for p in pieces {
            let expected_ms = p.samples.len() as f64 / BATCH_SAMPLE_RATE as f64 * 1000.0;
            assert!(
                ((p.end_timestamp_ms - p.start_timestamp_ms) - expected_ms).abs() < 1.0,
                "piece duration must match its sample count"
            );
        }
    }

    #[test]
    fn auto_language_detection_is_recognised() {
        assert!(is_auto_language(None));
        assert!(is_auto_language(Some("auto")));
        assert!(is_auto_language(Some("auto-translate")));
        assert!(is_auto_language(Some("")));
        assert!(!is_auto_language(Some("ar")));
        assert!(!is_auto_language(Some("en")));
    }

    #[test]
    fn policy_is_short_only_for_whisper_auto() {
        assert_eq!(segment_split_policy(None, false), SegmentSplitPolicy::auto_language());
        assert_eq!(segment_split_policy(Some("auto"), false), SegmentSplitPolicy::auto_language());
        assert_eq!(
            segment_split_policy(Some("ar"), false),
            SegmentSplitPolicy::forced(FORCED_LANGUAGE_MAX_SEGMENT_SAMPLES)
        );
        // Parakeet does not detect language per call - keep long pieces.
        assert_eq!(
            segment_split_policy(None, true),
            SegmentSplitPolicy::forced(FORCED_LANGUAGE_MAX_SEGMENT_SAMPLES)
        );
    }

    #[test]
    fn auto_policy_splits_a_22s_segment_at_the_sentence_gaps() {
        // Three "sentences" (0-7s, 7.5-15s, 15.4-22s) with silence between them:
        // the middle one might be English inside Arabic - it must get its own piece.
        let segment = synthetic_segment(22.0, &[(0.0, 7.0), (7.5, 15.0), (15.4, 22.0)], 60_000.0);
        let pieces = split_segment_with_policy(&segment, &SegmentSplitPolicy::auto_language());

        assert_eq!(pieces.len(), 3, "expected one piece per sentence, got {:?}",
            pieces.iter().map(|p| (p.start_timestamp_ms, p.end_timestamp_ms)).collect::<Vec<_>>());
        assert_contiguous_cover(&segment, &pieces);

        // Cuts land inside the silence gaps (7.0-7.5s and 15.0-15.4s), not mid-sentence.
        let cut1 = (pieces[0].end_timestamp_ms - 60_000.0) / 1000.0;
        let cut2 = (pieces[1].end_timestamp_ms - 60_000.0) / 1000.0;
        assert!((7.0..=7.5).contains(&cut1), "first cut at {cut1}s should be in the 7.0-7.5s gap");
        assert!((15.0..=15.4).contains(&cut2), "second cut at {cut2}s should be in the 15.0-15.4s gap");

        for p in &pieces {
            assert!(p.samples.len() <= AUTO_LANGUAGE_MAX_SEGMENT_SAMPLES, "piece exceeds the 12s cap");
        }
    }

    #[test]
    fn forced_policy_keeps_the_same_22s_segment_whole() {
        let segment = synthetic_segment(22.0, &[(0.0, 7.0), (7.5, 15.0), (15.4, 22.0)], 0.0);
        let pieces = split_segment_with_policy(&segment, &SegmentSplitPolicy::forced(FORCED_LANGUAGE_MAX_SEGMENT_SAMPLES));
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].samples.len(), segment.samples.len());
    }

    #[test]
    fn auto_policy_respects_the_hard_cap_without_silence() {
        // 30s of continuous tone: no silence anywhere, so every cut is a fallback cut.
        let segment = synthetic_segment(30.0, &[(0.0, 30.0)], 0.0);
        let pieces = split_segment_with_policy(&segment, &SegmentSplitPolicy::auto_language());
        assert!(pieces.len() >= 3, "30s must become at least three <=12s pieces, got {}", pieces.len());
        assert_contiguous_cover(&segment, &pieces);
        for p in &pieces {
            assert!(p.samples.len() <= AUTO_LANGUAGE_MAX_SEGMENT_SAMPLES);
            assert!(p.samples.len() >= AUTO_LANGUAGE_MIN_SEGMENT_SAMPLES / 2, "piece too short: {}", p.samples.len());
        }
    }

    #[test]
    fn auto_policy_prefers_the_gap_nearest_the_target() {
        // Gaps at 5s and 8.5s: both silent, but 8.5s is closer to the 8s target
        // than 5s, so the first piece should end near 8.5s, not 5s.
        let segment = synthetic_segment(20.0, &[(0.0, 5.0), (5.3, 8.5), (8.8, 20.0)], 0.0);
        let pieces = split_segment_with_policy(&segment, &SegmentSplitPolicy::auto_language());
        let first_cut = pieces[0].end_timestamp_ms / 1000.0;
        assert!((8.5..=8.8).contains(&first_cut), "first cut at {first_cut}s should use the 8.5-8.8s gap");
        assert_contiguous_cover(&segment, &pieces);
    }

    #[test]
    fn short_segment_is_untouched_by_both_policies() {
        let segment = synthetic_segment(10.0, &[(0.0, 4.0), (4.5, 10.0)], 0.0);
        assert_eq!(split_segment_with_policy(&segment, &SegmentSplitPolicy::auto_language()).len(), 1);
        assert_eq!(split_segment_at_silence(&segment, FORCED_LANGUAGE_MAX_SEGMENT_SAMPLES).len(), 1);
    }

    #[tokio::test]
    async fn test_engine_lifecycle_lock_serializes_acquirers() {
        let guard = acquire_engine_lifecycle_lock().await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async {
            started_tx.send(()).unwrap();
            let _guard = acquire_engine_lifecycle_lock().await;
            acquired_tx.send(()).unwrap();
        });

        started_rx.await.unwrap();
        assert!(acquired_rx.try_recv().is_err());
        drop(guard);

        acquired_rx.await.unwrap();
        waiter.await.unwrap();
    }
}
