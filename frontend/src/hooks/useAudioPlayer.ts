'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/**
 * Playback for a meeting's local recording.
 *
 * The Rust side (`get_meeting_audio_path`) resolves the audio file inside the
 * meeting folder and whitelists it for the asset protocol; the webview then
 * streams it through an HTMLAudioElement via `convertFileSrc`. Streaming keeps
 * memory flat for multi-hour recordings (range requests, no decodeAudioData)
 * and gives us native seeking.
 *
 * `currentTime` in the returned state follows the element's `timeupdate`
 * event (~4 Hz) so the rest of the page re-renders sparingly; UI that wants a
 * smooth read-out (the seek slider) can poll `getCurrentTime()` on its own
 * animation frame.
 */

export type AudioPlayerStatus =
  | 'idle'        // no meeting selected
  | 'loading'     // resolving the file / fetching metadata
  | 'ready'       // playable
  | 'unavailable' // meeting has no local audio (e.g. synced from another device)
  | 'error';      // file exists but cannot be played

export interface MeetingAudioInfo {
  path: string;
  file_name: string;
  size_bytes: number;
}

export interface AudioPlayerState {
  status: AudioPlayerStatus;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  error: string | null;
  fileName: string | null;
}

export interface AudioPlayerControls {
  play: () => Promise<void>;
  pause: () => void;
  toggle: () => Promise<void>;
  /** Jump to a position (seconds). Optionally start playback afterwards. */
  seek: (seconds: number, options?: { play?: boolean }) => Promise<void>;
  /** Precise position straight from the media element (no re-render). */
  getCurrentTime: () => number;
  /** Re-run file resolution (after an error or once a recording finishes). */
  reload: () => void;
}

export type AudioPlayer = AudioPlayerState & AudioPlayerControls;

const INITIAL_STATE: AudioPlayerState = {
  status: 'idle',
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  error: null,
  fileName: null,
};

function describeMediaError(audio: HTMLAudioElement): string {
  switch (audio.error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'Playback was interrupted';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'The recording could not be read';
    case MediaError.MEDIA_ERR_DECODE:
      return 'The recording could not be decoded';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'This audio format is not supported for playback';
    default:
      return 'The recording could not be played';
  }
}

function clampTime(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  if (Number.isFinite(duration) && duration > 0 && seconds > duration) return duration;
  return seconds;
}

export function useAudioPlayer(meetingId: string | null | undefined): AudioPlayer {
  const [state, setState] = useState<AudioPlayerState>(INITIAL_STATE);
  const [reloadToken, setReloadToken] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<{ seconds: number; play: boolean } | null>(null);

  const patch = useCallback((update: Partial<AudioPlayerState>) => {
    setState((prev) => ({ ...prev, ...update }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    pendingSeekRef.current = null;
    setState(INITIAL_STATE);

    if (!meetingId) {
      return undefined;
    }

    patch({ status: 'loading' });

    let audio: HTMLAudioElement | null = null;
    const listeners: Array<[string, EventListener]> = [];

    const attach = (info: MeetingAudioInfo) => {
      const element = new Audio();
      element.preload = 'metadata';
      audio = element;
      audioRef.current = element;

      const on = (event: string, handler: EventListener) => {
        element.addEventListener(event, handler);
        listeners.push([event, handler]);
      };

      const readDuration = () => (Number.isFinite(element.duration) ? element.duration : 0);

      on('loadedmetadata', () => {
        patch({ status: 'ready', duration: readDuration(), error: null });
        const pending = pendingSeekRef.current;
        if (pending) {
          pendingSeekRef.current = null;
          element.currentTime = clampTime(pending.seconds, element.duration);
          patch({ currentTime: element.currentTime });
          if (pending.play) {
            void element.play().catch((err) => {
              console.error('Audio playback failed:', err);
              patch({ error: 'Playback could not start' });
            });
          }
        }
      });
      on('durationchange', () => patch({ duration: readDuration() }));
      on('timeupdate', () => patch({ currentTime: element.currentTime }));
      on('seeked', () => patch({ currentTime: element.currentTime }));
      on('play', () => patch({ isPlaying: true, error: null }));
      on('pause', () => patch({ isPlaying: false, currentTime: element.currentTime }));
      on('ended', () => patch({ isPlaying: false, currentTime: readDuration() }));
      on('error', () => {
        console.error('Audio element error:', element.error);
        patch({ status: 'error', isPlaying: false, error: describeMediaError(element) });
      });

      patch({ fileName: info.file_name });
      element.src = convertFileSrc(info.path);
      element.load();
    };

    invoke<MeetingAudioInfo | null>('get_meeting_audio_path', { meetingId })
      .then((info) => {
        if (cancelled) return;
        if (!info) {
          patch({ status: 'unavailable' });
          return;
        }
        attach(info);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to resolve meeting audio:', err);
        patch({ status: 'error', error: typeof err === 'string' ? err : 'Could not locate the recording' });
      });

    return () => {
      cancelled = true;
      if (audio) {
        for (const [event, handler] of listeners) audio.removeEventListener(event, handler);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [meetingId, reloadToken, patch]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
    } catch (err) {
      console.error('Audio playback failed:', err);
      patch({ isPlaying: false, error: 'Playback could not start' });
    }
  }, [patch]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      await play();
    } else {
      audio.pause();
    }
  }, [play]);

  const seek = useCallback(async (seconds: number, options?: { play?: boolean }) => {
    const audio = audioRef.current;
    const shouldPlay = options?.play ?? false;
    if (!audio || audio.readyState < HTMLMediaElement.HAVE_METADATA) {
      // Metadata not loaded yet: apply once it is.
      pendingSeekRef.current = { seconds, play: shouldPlay };
      return;
    }
    const target = clampTime(seconds, audio.duration);
    audio.currentTime = target;
    patch({ currentTime: target });
    if (shouldPlay && audio.paused) {
      await play();
    }
  }, [patch, play]);

  const getCurrentTime = useCallback(() => audioRef.current?.currentTime ?? 0, []);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { ...state, play, pause, toggle, seek, getCurrentTime, reload };
}
