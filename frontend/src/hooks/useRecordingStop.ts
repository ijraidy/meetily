import { useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { storageService } from '@/services/storageService';
import { transcriptService } from '@/services/transcriptService';
import Analytics from '@/lib/analytics';
import {
  applyPinnedSummaryLanguageToMeeting,
  detectAndCacheSummaryLanguage,
} from '@/lib/summary-language-preferences';

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

interface UseRecordingStopReturn {
  handleRecordingStop: (callApi: boolean) => Promise<void>;
  isStopping: boolean;
  isProcessingTranscript: boolean;
  isSavingTranscript: boolean;
  summaryStatus: SummaryStatus;
  setIsStopping: (value: boolean) => void;
}

/** Payload of the Rust `recording-stopped` event (audio/recording_commands.rs). */
interface RecordingStoppedPayload {
  message: string;
  session_id?: string | null;
  folder_path?: string | null;
  meeting_name?: string | null;
  transcription_incomplete?: boolean;
  transcription_reason?: string;
  chunks_queued?: number;
  chunks_transcribed?: number;
  chunks_dropped?: number;
}

/** Subset of `get_recording_state` we need here. */
interface BackendRecordingState {
  is_recording: boolean;
  is_stopping?: boolean;
  session_id?: string | null;
}

// ---------------------------------------------------------------------------
// Module-level (process-wide) stop state.
//
// `useRecordingStop` is mounted twice: once by the home page (fed by the Stop
// button through RecordingControls.onRecordingStop) and once by
// RecordingPostProcessingProvider (fed by the Rust `recording-stop-complete`
// event that tray / shortcut stops emit). A per-instance `useRef` guard cannot
// see the other instance, so a stop that reached both paths saved the meeting
// twice (two `meetings` rows 0.5 s apart, the second with `folder_path` NULL
// because the first had already cleared sessionStorage). Everything that must
// be shared between the instances lives here instead.
// ---------------------------------------------------------------------------

/** Latest `recording-stopped` payload, consumed by the save. */
let lastRecordingStopped: RecordingStoppedPayload | null = null;
/** True while any instance is inside `handleRecordingStop`. */
let stopHandlerActive = false;

const SESSION_FOLDER_KEY = 'last_recording_folder_path';
const SESSION_NAME_KEY = 'last_recording_meeting_name';

function rememberRecordingStopped(payload: RecordingStoppedPayload) {
  lastRecordingStopped = payload;
  // sessionStorage mirror survives a webview reload mid-stop.
  try {
    if (payload.folder_path) {
      sessionStorage.setItem(SESSION_FOLDER_KEY, payload.folder_path);
    }
    if (payload.meeting_name) {
      sessionStorage.setItem(SESSION_NAME_KEY, payload.meeting_name);
    }
  } catch {
    // sessionStorage unavailable - module state still carries the payload
  }
}

function forgetRecordingStopped() {
  lastRecordingStopped = null;
  try {
    sessionStorage.removeItem(SESSION_FOLDER_KEY);
    sessionStorage.removeItem(SESSION_NAME_KEY);
    // IndexedDB meeting id (redundant with markMeetingAsSaved cleanup, but ensures cleanup)
    sessionStorage.removeItem('indexeddb_current_meeting_id');
  } catch {
    // ignore
  }
}

async function readBackendRecordingState(): Promise<BackendRecordingState | null> {
  try {
    return await invoke<BackendRecordingState>('get_recording_state');
  } catch (error) {
    console.warn('Could not read backend recording state:', error);
    return null;
  }
}

/**
 * Custom hook for managing recording stop lifecycle.
 * Handles the stop sequence: transcription wait → buffer flush → SQLite save → navigation.
 *
 * Features:
 * - Single owner of the post-stop save across all hook instances
 * - Idempotent SQLite save keyed by the backend recording session id (folder path fallback)
 * - Bounded transcription wait; the meeting is saved even if transcription was cut short,
 *   with a clear "transcription incomplete" warning instead of a silent loss
 * - Auto-navigation to meeting details
 * - Toast notifications for success/error
 * - Window exposure for Rust callbacks
 */
export function useRecordingStop(
  setIsRecording: (value: boolean) => void,
  setIsRecordingDisabled: (value: boolean) => void
): UseRecordingStopReturn {
  // USE global state instead
  const recordingState = useRecordingState();
  const {
    status,
    setStatus,
    isStopping,
    isProcessing: isProcessingTranscript,
    isSaving: isSavingTranscript
  } = recordingState;

  const {
    transcriptsRef,
    flushBuffer,
    clearTranscripts,
    meetingTitle,
    markMeetingAsSaved,
  } = useTranscripts();

  const {
    refetchMeetings,
    setCurrentMeeting,
    setIsMeetingActive,
  } = useSidebar();

  const router = useRouter();

  // Promise that resolves once the latest recording-stopped payload has been recorded
  // (keeps the ordering guarantee between `recording-stopped` and `recording-stop-complete`).
  const recordingStoppedDataRef = useRef<Promise<void> | null>(null);

  // Set up recording-stopped listener: capture the backend's metadata for the save
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let cancelled = false;

    const setupRecordingStoppedListener = async () => {
      try {
        console.log('Setting up recording-stopped listener for navigation...');
        const fn = await listen<RecordingStoppedPayload>('recording-stopped', (event) => {
          recordingStoppedDataRef.current = (async () => {
            rememberRecordingStopped(event.payload);
            const p = event.payload;
            console.log('recording-stopped payload captured', {
              session_id: p.session_id,
              folder_path: p.folder_path,
              meeting_name: p.meeting_name,
              transcription_incomplete: p.transcription_incomplete,
              chunks: `${p.chunks_transcribed ?? '?'}/${p.chunks_queued ?? '?'} (dropped ${p.chunks_dropped ?? 0})`,
            });
          })();
        });
        if (cancelled) {
          fn();
          return;
        }
        unlistenFn = fn;
        console.log('Recording stopped listener setup complete');
      } catch (error) {
        console.error('Failed to setup recording stopped listener:', error);
      }
    };

    setupRecordingStoppedListener();

    return () => {
      console.log('Cleaning up recording stopped listener...');
      cancelled = true;
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [router]);

  // Main recording stop handler
  const handleRecordingStop = useCallback(async (isCallApi: boolean) => {
    if (recordingStoppedDataRef.current) {
      await recordingStoppedDataRef.current;
    }

    // Guard: exactly one post-stop pass at a time, across ALL hook instances
    if (stopHandlerActive) {
      console.log('handleRecordingStop ignored - another instance owns the current stop');
      return;
    }
    stopHandlerActive = true;

    const stopStartTime = Date.now();

    try {
      if (!isCallApi) {
        // The caller's stop_recording invoke failed. If a stop tail is still
        // running in the backend (e.g. this was the duplicate of a tray stop)
        // leave the status to the pass that owns it; otherwise settle to IDLE.
        const backend = await readBackendRecordingState();
        if (backend?.is_stopping || backend?.is_recording) {
          console.log('Stop invoke failed but the backend is still stopping/recording - leaving state untouched');
          return;
        }
        console.log('Stop invoke failed and no backend stop is running - resetting to IDLE');
        setStatus(RecordingStatus.IDLE);
        setIsRecording(false);
        setIsMeetingActive(false);
        setIsRecordingDisabled(false);
        return;
      }

      // Set status to STOPPING immediately
      setStatus(RecordingStatus.STOPPING);
      setIsRecording(false);
      setIsRecordingDisabled(true);

      console.log('Post-stop processing...', {
        stop_initiated_at: new Date(stopStartTime).toISOString(),
        current_transcript_count: transcriptsRef.current.length
      });

      // Resolve the recording identity: backend payload first, sessionStorage
      // mirror second (webview reloaded mid-stop), backend state last.
      let stopped = lastRecordingStopped;
      let folderPath: string | null = stopped?.folder_path ?? null;
      let savedMeetingName: string | null = stopped?.meeting_name ?? null;
      let sessionId: string | null = stopped?.session_id ?? null;
      if (!folderPath || !savedMeetingName) {
        try {
          folderPath = folderPath || sessionStorage.getItem(SESSION_FOLDER_KEY);
          savedMeetingName = savedMeetingName || sessionStorage.getItem(SESSION_NAME_KEY);
        } catch {
          // ignore
        }
      }
      if (!sessionId) {
        const backend = await readBackendRecordingState();
        sessionId = backend?.session_id ?? null;
      }
      const sessionKey = sessionId || folderPath || null;

      if (sessionKey && storageService.hasSavedMeeting(sessionKey)) {
        const existingId = storageService.getSavedMeetingId(sessionKey);
        console.warn(`Meeting for recording ${sessionKey} already saved (${existingId ?? 'in flight'}) - skipping duplicate save`);
        setStatus(RecordingStatus.IDLE);
        setIsMeetingActive(false);
        setIsRecordingDisabled(false);
        return;
      }

      // Wait (bounded) for the live transcription queue to settle. The Rust stop
      // tail already drained or abandoned the queue before emitting
      // `recording-stopped`, so this normally returns on the first poll; it is a
      // safety net, never a reason to skip the save.
      setStatus(RecordingStatus.PROCESSING_TRANSCRIPTS, 'Waiting for transcription...');
      const MAX_WAIT_TIME = 15000;
      const POLL_INTERVAL = 500;
      let elapsedTime = 0;
      // The backend already reported the drain as abandoned: nothing more will
      // arrive, so do not sit in the poll loop.
      let transcriptionSettled = Boolean(stopped?.transcription_incomplete);

      while (!transcriptionSettled && elapsedTime < MAX_WAIT_TIME) {
        try {
          const queue = await transcriptService.getTranscriptionStatus();
          if (queue.chunks_in_queue === 0) {
            transcriptionSettled = true;
            break;
          }
          setStatus(RecordingStatus.PROCESSING_TRANSCRIPTS, `Processing ${queue.chunks_in_queue} remaining chunks...`);
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
          elapsedTime += POLL_INTERVAL;
        } catch (error) {
          console.error('Error checking transcription status:', error);
          break;
        }
      }

      if (!transcriptionSettled) {
        console.warn('⏰ Transcription queue did not settle within', elapsedTime, 'ms - saving what we have');
      } else {
        console.log('✅ Transcription queue settled after', elapsedTime, 'ms');
      }

      // Short grace for late transcript-update events, then force the buffer through.
      await new Promise(resolve => setTimeout(resolve, 2000));
      setStatus(RecordingStatus.PROCESSING_TRANSCRIPTS, 'Flushing transcript buffer...');
      flushBuffer();
      await new Promise(resolve => setTimeout(resolve, 500));

      const transcriptionIncomplete = Boolean(stopped?.transcription_incomplete) || !transcriptionSettled;
      if (transcriptionIncomplete) {
        const dropped = stopped?.chunks_dropped ?? 0;
        const reason = stopped?.transcription_reason ?? 'timeout';
        const reasonText = reason === 'stalled' || reason === 'hard_cap'
          ? 'the speech engine was busy (an import or retranscription may have been running)'
          : 'the transcription queue did not finish in time';
        console.warn(`⚠️ Transcription incomplete (${reason}): ${dropped} chunk(s) dropped`);
        toast.warning('Transcription incomplete', {
          description: `${dropped > 0 ? `${dropped} audio chunk(s) were not transcribed` : 'Some audio may not have been transcribed'} because ${reasonText}. The audio file was saved; use Retranscribe on the meeting to fill the gap.`,
          duration: 12000,
        });
      }

      setStatus(RecordingStatus.SAVING, 'Saving meeting to database...');

      // Fresh transcript state (ALL transcripts including late ones)
      const freshTranscripts = [...transcriptsRef.current];
      const titleToSave = savedMeetingName || meetingTitle || 'New Meeting'; // PREFER backend name

      console.log('💾 Saving meeting to database...', {
        session_key: sessionKey,
        transcript_count: freshTranscripts.length,
        meeting_name: titleToSave,
        folder_path: folderPath,
        transcription_incomplete: transcriptionIncomplete,
      });

      try {
        const responseData = await storageService.saveMeeting(
          titleToSave,
          freshTranscripts,
          folderPath,
          { idempotencyKey: sessionKey ?? undefined }
        );

        const meetingId = responseData.meeting_id;
        if (!meetingId) {
          console.error('No meeting_id in response:', responseData);
          throw new Error('No meeting ID received from save operation');
        }

        let shouldDetectSummaryLanguage = false;
        try {
          shouldDetectSummaryLanguage = !(await applyPinnedSummaryLanguageToMeeting(meetingId));
        } catch (error) {
          console.warn('Failed to apply pinned summary language preference for new meeting:', error);
          toast.warning('Could not apply default summary language', {
            description: 'The meeting was saved, but the default summary language was not applied.',
          });
        }

        if (shouldDetectSummaryLanguage) {
          try {
            await detectAndCacheSummaryLanguage(
              meetingId,
              freshTranscripts.map(t => t.text)
            );
          } catch (error) {
            console.warn('Failed to detect summary language for new meeting:', error);
            toast.warning('Could not detect summary language', {
              description: 'The meeting was saved, but Auto could not detect the summary language.',
            });
          }
        }

        console.log('✅ Saved meeting with ID:', meetingId, {
          transcripts: freshTranscripts.length,
          folder_path: folderPath,
        });

        // Mark meeting as saved in IndexedDB (for recovery system)
        await markMeetingAsSaved();

        // This recording's metadata is consumed; a later stop must not reuse it.
        if (lastRecordingStopped === stopped) {
          forgetRecordingStopped();
        }

        // Refetch meetings and set current meeting
        await refetchMeetings();

        try {
          const meetingData = await storageService.getMeeting(meetingId);
          if (meetingData) {
            setCurrentMeeting({
              id: meetingId,
              title: meetingData.title
            });
            console.log('✅ Current meeting set:', meetingData.title);
          }
        } catch (error) {
          console.warn('Could not fetch meeting details, using ID only:', error);
          setCurrentMeeting({ id: meetingId, title: titleToSave });
        }

        // Mark as completed
        setStatus(RecordingStatus.COMPLETED);

        // Show success toast with navigation option
        toast.success(transcriptionIncomplete ? 'Recording saved (transcription incomplete)' : 'Recording saved successfully!', {
          description: `${freshTranscripts.length} transcript segments saved.`,
          action: {
            label: 'View Meeting',
            onClick: () => {
              router.push(`/meeting-details?id=${meetingId}`);
              Analytics.trackButtonClick('view_meeting_from_toast', 'recording_complete');
            }
          },
          duration: 10000,
        });

        // Auto-navigate after a short delay with source parameter
        setTimeout(() => {
          router.push(`/meeting-details?id=${meetingId}&source=recording`);
          clearTranscripts();
          Analytics.trackPageView('meeting_details');

          // Reset to IDLE after navigation
          setStatus(RecordingStatus.IDLE);
        }, 2000);

        // Track meeting completion analytics (inert facade, kept for parity)
        try {
          let durationSeconds = 0;
          if (freshTranscripts.length > 0 && freshTranscripts[0].audio_start_time !== undefined) {
            const lastTranscript = freshTranscripts[freshTranscripts.length - 1];
            durationSeconds = lastTranscript.audio_end_time || lastTranscript.audio_start_time || 0;
          }
          const transcriptWordCount = freshTranscripts
            .map(t => t.text.split(/\s+/).length)
            .reduce((a, b) => a + b, 0);
          const wordsPerMinute = durationSeconds > 0 ? transcriptWordCount / (durationSeconds / 60) : 0;
          const meetingsToday = await Analytics.getMeetingsCountToday();

          await Analytics.trackMeetingCompleted(meetingId, {
            duration_seconds: durationSeconds,
            transcript_segments: freshTranscripts.length,
            transcript_word_count: transcriptWordCount,
            words_per_minute: wordsPerMinute,
            meetings_today: meetingsToday
          });
          await Analytics.updateMeetingCount();

          const { Store } = await import('@tauri-apps/plugin-store');
          const store = await Store.load('analytics.json');
          const totalMeetings = await store.get<number>('total_meetings');
          if (totalMeetings === 1) {
            const daysSinceInstall = await Analytics.calculateDaysSince('first_launch_date');
            await Analytics.track('user_activated', {
              meetings_count: '1',
              days_since_install: daysSinceInstall?.toString() || 'null',
              first_meeting_duration_seconds: durationSeconds.toString()
            });
          }
        } catch (analyticsError) {
          console.error('Failed to track meeting completion analytics:', analyticsError);
        }
      } catch (saveError) {
        console.error('Failed to save meeting to database:', saveError);
        setStatus(RecordingStatus.ERROR, saveError instanceof Error ? saveError.message : 'Unknown error');
        toast.error('Failed to save meeting', {
          description: `${saveError instanceof Error ? saveError.message : 'Unknown error'}. The transcript is kept for recovery on the home page.`,
          duration: 12000,
        });
        throw saveError;
      }

      setIsMeetingActive(false);
      // isRecording already set to false at function start
      setIsRecordingDisabled(false);
    } catch (error) {
      console.error('Error in handleRecordingStop:', error);
      setStatus(RecordingStatus.ERROR, error instanceof Error ? error.message : 'Unknown error');
      setIsRecordingDisabled(false);
    } finally {
      // Always release the process-wide guard when done
      stopHandlerActive = false;
    }
  }, [
    setIsRecording,
    setIsRecordingDisabled,
    setStatus,
    transcriptsRef,
    flushBuffer,
    clearTranscripts,
    meetingTitle,
    markMeetingAsSaved,
    refetchMeetings,
    setCurrentMeeting,
    setIsMeetingActive,
    router,
  ]);

  // Expose handleRecordingStop function to window for Rust callbacks
  const handleRecordingStopRef = useRef(handleRecordingStop);
  useEffect(() => {
    handleRecordingStopRef.current = handleRecordingStop;
  });

  useEffect(() => {
    (window as any).handleRecordingStop = (callApi: boolean = true) => {
      handleRecordingStopRef.current(callApi);
    };

    // Cleanup on unmount
    return () => {
      delete (window as any).handleRecordingStop;
    };
  }, []);

  // Derive summaryStatus from RecordingStatus for backward compatibility
  const summaryStatus: SummaryStatus = status === RecordingStatus.PROCESSING_TRANSCRIPTS ? 'processing' : 'idle';

  return {
    handleRecordingStop,
    isStopping,
    isProcessingTranscript,
    isSavingTranscript,
    summaryStatus,
    setIsStopping: (value: boolean) => {
      setStatus(value ? RecordingStatus.STOPPING : RecordingStatus.IDLE);
    },
  };
}
