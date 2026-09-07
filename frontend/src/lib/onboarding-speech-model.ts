import { DEFAULT_WHISPER_MODEL } from '@/constants/modelDefaults';
import { MODEL_CONFIGS } from '@/lib/whisper';

/**
 * Speech-recognition model installed during onboarding.
 *
 * This build targets Arabic and mixed Arabic/English meetings, so onboarding
 * installs a multilingual Whisper model instead of Parakeet (Parakeet TDT v3
 * covers 25 European languages and has no Arabic support). The model name must
 * exist in the Whisper catalog in `src-tauri/src/config.rs`.
 */
export const SPEECH_MODEL = DEFAULT_WHISPER_MODEL;

/** Approximate download size in MB, used for progress display before the engine reports bytes. */
export const SPEECH_MODEL_SIZE_MB = MODEL_CONFIGS[SPEECH_MODEL]?.size_mb ?? 547;

/** Human-readable label shown on the onboarding download screen. */
export const SPEECH_MODEL_LABEL = 'Whisper large-v3-turbo (multilingual, Arabic + English)';

/** Payload of the `model-download-progress` event emitted by `whisper_download_model`. */
export interface SpeechModelDownloadProgressEvent {
  modelName: string;
  progress: number;
}

/** Payload of the `model-download-complete` event. */
export interface SpeechModelDownloadCompleteEvent {
  modelName: string;
}

/** Payload of the `model-download-error` event. */
export interface SpeechModelDownloadErrorEvent {
  modelName: string;
  error: string;
}

/** Estimate downloaded MB from a percentage when the engine only reports progress. */
export function estimateDownloadedMb(progress: number): number {
  const clamped = Math.max(0, Math.min(100, progress));
  return Math.round((SPEECH_MODEL_SIZE_MB * clamped) / 100);
}
