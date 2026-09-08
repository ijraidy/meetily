import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { recordingService } from '@/services/recordingService';
import Analytics from '@/lib/analytics';
import { showRecordingNotification } from '@/lib/recordingNotification';
import {
  getProviderCommands,
  hasDownloadingModel,
  type ModelWithStatus,
} from '@/lib/transcription-model-readiness';
import { toast } from 'sonner';

interface UseRecordingStartReturn {
  handleRecordingStart: () => Promise<void>;
  isAutoStarting: boolean;
}

interface TranscriptConfig {
  provider?: string;
}

/**
 * Audio import and retranscription share the live recording's Whisper/Parakeet
 * engine, so the backend refuses `start_recording` while either is running
 * (`batch_job_blocking_start` in audio/recording_commands.rs). Ask first so the
 * user gets a clear toast instead of a generic "Recording Failed" dialog.
 * Returns the reason to show, or null when recording may start.
 */
async function getBatchJobBlockingStart(): Promise<string | null> {
  try {
    const [importRunning, retranscribeRunning] = await Promise.all([
      invoke<boolean>('is_import_in_progress_command'),
      invoke<boolean>('is_retranscription_in_progress_command'),
    ]);
    if (importRunning) {
      return 'An audio import is still running. Wait for it to finish (or cancel it) before recording.';
    }
    if (retranscribeRunning) {
      return 'A retranscription is still running. Wait for it to finish (or cancel it) before recording.';
    }
  } catch (error) {
    // The backend start command re-checks and refuses with the same message.
    console.warn('Could not query import/retranscription state before recording:', error);
  }
  return null;
}

/** The backend refused the start because an import/retranscription holds the engine. */
function isEngineBusyError(errorMsg: string): boolean {
  return errorMsg.includes('Cannot start recording while');
}

function showEngineBusyToast(reason: string) {
  toast.info('Speech engine is busy', {
    description: reason,
    duration: 6000,
  });
}

/**
 * Custom hook for managing recording start lifecycle.
 * Handles both manual start (button click) and auto-start (from sidebar navigation).
 *
 * Features:
 * - Meeting title generation (format: Meeting DD_MM_YY_HH_MM_SS)
 * - Transcript clearing on start
 * - Analytics tracking
 * - Recording notification display
 * - Auto-start from sidebar via sessionStorage flag
 */
export function useRecordingStart(
  isRecording: boolean,
  setIsRecording: (value: boolean) => void,
  showModal?: (name: 'modelSelector', message?: string) => void
): UseRecordingStartReturn {
  const [isAutoStarting, setIsAutoStarting] = useState(false);

  // Synchronous latch: a rapid double-click re-enters handleRecordingStart
  // before any state update lands, so an async/state guard can't stop it.
  const isStartingRef = useRef(false);

  const { clearTranscripts, setMeetingTitle } = useTranscripts();
  const { setIsMeetingActive } = useSidebar();
  const { selectedDevices } = useConfig();
  const { setStatus } = useRecordingState();

  // Generate meeting title with timestamp
  const generateMeetingTitle = useCallback(() => {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = String(now.getFullYear()).slice(-2);
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `Meeting ${day}_${month}_${year}_${hours}_${minutes}_${seconds}`;
  }, []);

  const getTranscriptionProvider = useCallback(async (): Promise<string> => {
    try {
      const config = await invoke<TranscriptConfig | null>('api_get_transcript_config');
      return config?.provider || 'localWhisper';
    } catch (error) {
      console.error('Failed to load transcription provider:', error);
      return 'localWhisper';
    }
  }, []);

  // Check the selected local transcription provider, not a hardcoded engine.
  const checkTranscriptionModelReady = useCallback(async (): Promise<boolean> => {
    try {
      const provider = await getTranscriptionProvider();
      const commands = getProviderCommands(provider);

      if (commands) {
        await invoke(commands.initialize);
        return await invoke<boolean>(commands.hasAvailableModels);
      }

      console.error(`Unsupported transcription provider: ${provider}`);
      return false;
    } catch (error) {
      console.error('Failed to check transcription model status:', error);
      return false;
    }
  }, [getTranscriptionProvider]);

  // Check download status for the selected local transcription provider.
  const checkIfModelDownloading = useCallback(async (): Promise<boolean> => {
    try {
      const provider = await getTranscriptionProvider();
      const commands = getProviderCommands(provider);
      if (!commands) return false;

      const models = await invoke<ModelWithStatus[]>(commands.getAvailableModels);
      return hasDownloadingModel(models);
    } catch (error) {
      console.error('Failed to check model download status:', error);
      return false; // Default to not downloading (will show error + modal)
    }
  }, [getTranscriptionProvider]);

  // The Rust recording command validates the same provider again before capture.
  const checkModelReady = checkTranscriptionModelReady;

  // Handle manual recording start (from button click)
  const handleRecordingStart = useCallback(async () => {
    if (isStartingRef.current) {
      console.log('handleRecordingStart ignored - start already in progress');
      return;
    }
    isStartingRef.current = true;
    try {
      console.log('handleRecordingStart called - checking selected transcription model status');

      // Check the selected transcription model before starting.
      const modelReady = await checkModelReady();
      if (!modelReady) {
        const isDownloading = await checkIfModelDownloading();
        if (isDownloading) {
          toast.info('Model download in progress', {
            description: 'Please wait for the transcription model to finish downloading before recording.',
            duration: 5000,
          });
          Analytics.trackButtonClick('start_recording_blocked_downloading', 'home_page');
        } else {
          toast.error('Transcription model not ready', {
            description: 'Please download a transcription model before recording.',
            duration: 5000,
          });
          showModal?.('modelSelector', 'Transcription model setup required');
          Analytics.trackButtonClick('start_recording_blocked_missing', 'home_page');
        }
        setStatus(RecordingStatus.IDLE);
        return;
      }

      // Refuse to share the engine with a running import / retranscription.
      const busyReason = await getBatchJobBlockingStart();
      if (busyReason) {
        console.warn('handleRecordingStart blocked:', busyReason);
        showEngineBusyToast(busyReason);
        Analytics.trackButtonClick('start_recording_blocked_engine_busy', 'home_page');
        setStatus(RecordingStatus.IDLE);
        return;
      }

      console.log('Selected transcription model ready - setting up meeting title and state');

      const randomTitle = generateMeetingTitle();
      setMeetingTitle(randomTitle);

      // Set STARTING status before initiating backend recording
      setStatus(RecordingStatus.STARTING, 'Initializing recording...');

      // Start the actual backend recording
      console.log('Starting backend recording with meeting:', randomTitle);
      await recordingService.startRecordingWithDevices(
        selectedDevices?.micDevice || null,
        selectedDevices?.systemDevice || null,
        randomTitle
      );
      console.log('Backend recording started successfully');

      // Update state after successful backend start
      // Note: RECORDING status will be set by RecordingStateContext event listener
      console.log('Setting isRecordingState to true');
      setIsRecording(true); // This will also update the sidebar via the useEffect
      clearTranscripts(); // Clear previous transcripts when starting new recording
      setIsMeetingActive(true);
      Analytics.trackButtonClick('start_recording', 'home_page');

      // Show recording notification if enabled
      await showRecordingNotification();
    } catch (error) {
      console.error('Failed to start recording:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);

      // A racing second start that lost to a live recording must not clobber
      // the running recording's state. The winning start is live, so reflect
      // RECORDING here — leaving STARTING latched would keep the Stop button
      // disabled forever, since it's gated on isStartingRecording.
      if (errorMsg.includes('already in progress')) {
        console.warn('Start rejected because recording is already active - leaving live recording state untouched');
        setStatus(RecordingStatus.RECORDING);
        Analytics.trackButtonClick('start_recording_error', 'home_page');
        return;
      }

      // Lost the race with an import/retranscription that started after our
      // pre-check: a clear toast, back to IDLE, and no error dialog.
      if (isEngineBusyError(errorMsg)) {
        console.warn('Start refused by backend - engine busy:', errorMsg);
        showEngineBusyToast(errorMsg);
        setStatus(RecordingStatus.IDLE);
        setIsRecording(false);
        Analytics.trackButtonClick('start_recording_blocked_engine_busy', 'home_page');
        return;
      }

      if (errorMsg.includes('Recording start timed out')) {
        toast.error('Recording start timed out — please try again');
      }

      setStatus(RecordingStatus.ERROR, error instanceof Error ? error.message : 'Failed to start recording');
      setIsRecording(false); // Reset state on error
      Analytics.trackButtonClick('start_recording_error', 'home_page');
      // Re-throw so RecordingControls can handle device-specific errors
      throw error;
    } finally {
      isStartingRef.current = false;
    }
  }, [generateMeetingTitle, setMeetingTitle, setIsRecording, clearTranscripts, setIsMeetingActive, checkModelReady, checkIfModelDownloading, selectedDevices, showModal, setStatus]);

  // Check for autoStartRecording flag and start recording automatically
  useEffect(() => {
    const checkAutoStartRecording = async () => {
      if (typeof window !== 'undefined') {
        const shouldAutoStart = sessionStorage.getItem('autoStartRecording');
        if (shouldAutoStart === 'true' && !isRecording && !isAutoStarting) {
          console.log('Auto-starting recording from navigation...');
          setIsAutoStarting(true);
          sessionStorage.removeItem('autoStartRecording'); // Clear the flag

          // Check the selected transcription model before starting.
          const modelReady = await checkModelReady();
          if (!modelReady) {
            const isDownloading = await checkIfModelDownloading();
            if (isDownloading) {
              toast.info('Model download in progress', {
                description: 'Please wait for the transcription model to finish downloading before recording.',
                duration: 5000,
              });
              Analytics.trackButtonClick('start_recording_blocked_downloading', 'sidebar_auto');
            } else {
              toast.error('Transcription model not ready', {
                description: 'Please download a transcription model before recording.',
                duration: 5000,
              });
              showModal?.('modelSelector', 'Transcription model setup required');
              Analytics.trackButtonClick('start_recording_blocked_missing', 'sidebar_auto');
            }
            setStatus(RecordingStatus.IDLE);
            setIsAutoStarting(false);
            return;
          }

          const busyReason = await getBatchJobBlockingStart();
          if (busyReason) {
            console.warn('Auto-start blocked:', busyReason);
            showEngineBusyToast(busyReason);
            Analytics.trackButtonClick('start_recording_blocked_engine_busy', 'sidebar_auto');
            setStatus(RecordingStatus.IDLE);
            setIsAutoStarting(false);
            return;
          }

          // Start the actual backend recording
          try {
            // Generate meeting title
            const generatedMeetingTitle = generateMeetingTitle();

            // Set STARTING status before initiating backend recording
            setStatus(RecordingStatus.STARTING, 'Initializing recording...');

            console.log('Auto-starting backend recording with meeting:', generatedMeetingTitle);
            const result = await recordingService.startRecordingWithDevices(
              selectedDevices?.micDevice || null,
              selectedDevices?.systemDevice || null,
              generatedMeetingTitle
            );
            console.log('Auto-start backend recording result:', result);

            // Update UI state after successful backend start
            // Note: RECORDING status will be set by RecordingStateContext event listener
            setMeetingTitle(generatedMeetingTitle);
            setIsRecording(true);
            clearTranscripts();
            setIsMeetingActive(true);
            Analytics.trackButtonClick('start_recording', 'sidebar_auto');

            // Show recording notification if enabled
            await showRecordingNotification();
          } catch (error) {
            console.error('Failed to auto-start recording:', error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (isEngineBusyError(errorMsg)) {
              showEngineBusyToast(errorMsg);
              setStatus(RecordingStatus.IDLE);
              Analytics.trackButtonClick('start_recording_blocked_engine_busy', 'sidebar_auto');
            } else if (errorMsg.includes('already in progress')) {
              // Benign race — another start won and is live; skip ERROR/alert.
              setStatus(RecordingStatus.RECORDING);
              Analytics.trackButtonClick('start_recording_error', 'sidebar_auto');
            } else {
              setStatus(RecordingStatus.ERROR, errorMsg);
              alert('Failed to start recording. Check console for details.');
              Analytics.trackButtonClick('start_recording_error', 'sidebar_auto');
            }
          } finally {
            setIsAutoStarting(false);
          }
        }
      }
    };

    checkAutoStartRecording();
  }, [
    isRecording,
    isAutoStarting,
    selectedDevices,
    generateMeetingTitle,
    setMeetingTitle,
    setIsRecording,
    clearTranscripts,
    setIsMeetingActive,
    checkModelReady,
    checkIfModelDownloading,
    showModal,
    setStatus,
  ]);

  // Listen for direct recording trigger from sidebar when already on home page
  useEffect(() => {
    const handleDirectStart = async () => {
      if (isRecording || isAutoStarting) {
        console.log('Recording already in progress, ignoring direct start event');
        return;
      }

      console.log('Direct start from sidebar - checking selected transcription model status');
      setIsAutoStarting(true);

      // Check the selected transcription model before starting.
      const modelReady = await checkModelReady();
      if (!modelReady) {
        const isDownloading = await checkIfModelDownloading();
        if (isDownloading) {
          toast.info('Model download in progress', {
            description: 'Please wait for the transcription model to finish downloading before recording.',
            duration: 5000,
          });
          Analytics.trackButtonClick('start_recording_blocked_downloading', 'sidebar_direct');
        } else {
          toast.error('Transcription model not ready', {
            description: 'Please download a transcription model before recording.',
            duration: 5000,
          });
          showModal?.('modelSelector', 'Transcription model setup required');
          Analytics.trackButtonClick('start_recording_blocked_missing', 'sidebar_direct');
        }
        setStatus(RecordingStatus.IDLE);
        setIsAutoStarting(false);
        return;
      }

      const busyReason = await getBatchJobBlockingStart();
      if (busyReason) {
        console.warn('Direct start blocked:', busyReason);
        showEngineBusyToast(busyReason);
        Analytics.trackButtonClick('start_recording_blocked_engine_busy', 'sidebar_direct');
        setStatus(RecordingStatus.IDLE);
        setIsAutoStarting(false);
        return;
      }

      try {
        // Generate meeting title
        const generatedMeetingTitle = generateMeetingTitle();

        // Set STARTING status before initiating backend recording
        setStatus(RecordingStatus.STARTING, 'Initializing recording...');

        console.log('Starting backend recording with meeting:', generatedMeetingTitle);
        const result = await recordingService.startRecordingWithDevices(
          selectedDevices?.micDevice || null,
          selectedDevices?.systemDevice || null,
          generatedMeetingTitle
        );
        console.log('Backend recording result:', result);

        // Update UI state after successful backend start
        // Note: RECORDING status will be set by RecordingStateContext event listener
        setMeetingTitle(generatedMeetingTitle);
        setIsRecording(true);
        clearTranscripts();
        setIsMeetingActive(true);
        Analytics.trackButtonClick('start_recording', 'sidebar_direct');

        // Show recording notification if enabled
        await showRecordingNotification();
      } catch (error) {
        console.error('Failed to start recording from sidebar:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (isEngineBusyError(errorMsg)) {
          showEngineBusyToast(errorMsg);
          setStatus(RecordingStatus.IDLE);
          Analytics.trackButtonClick('start_recording_blocked_engine_busy', 'sidebar_direct');
        } else if (errorMsg.includes('already in progress')) {
          // Benign race — another start won and is live; skip ERROR/alert.
          setStatus(RecordingStatus.RECORDING);
          Analytics.trackButtonClick('start_recording_error', 'sidebar_direct');
        } else {
          setStatus(RecordingStatus.ERROR, errorMsg);
          alert('Failed to start recording. Check console for details.');
          Analytics.trackButtonClick('start_recording_error', 'sidebar_direct');
        }
      } finally {
        setIsAutoStarting(false);
      }
    };

    window.addEventListener('start-recording-from-sidebar', handleDirectStart);

    return () => {
      window.removeEventListener('start-recording-from-sidebar', handleDirectStart);
    };
  }, [
    isRecording,
    isAutoStarting,
    selectedDevices,
    generateMeetingTitle,
    setMeetingTitle,
    setIsRecording,
    clearTranscripts,
    setIsMeetingActive,
    checkModelReady,
    checkIfModelDownloading,
    showModal,
    setStatus,
  ]);

  return {
    handleRecordingStart,
    isAutoStarting,
  };
}
