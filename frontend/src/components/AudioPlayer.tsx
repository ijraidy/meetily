'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Pause, Play, RefreshCw, VolumeX } from 'lucide-react';
import type { AudioPlayer as AudioPlayerHandle } from '@/hooks/useAudioPlayer';

export function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

interface AudioPlayerProps {
  player: AudioPlayerHandle;
  className?: string;
}

/**
 * Compact playback bar for the meeting details page: play/pause, a seek slider
 * and elapsed/total time. Renders nothing when there is no meeting selected.
 */
export function AudioPlayer({ player, className }: AudioPlayerProps) {
  const { status, isPlaying, currentTime, duration, error, getCurrentTime } = player;
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const [liveTime, setLiveTime] = useState(0);
  const pointerDownRef = useRef(false);

  // Smooth slider while playing: poll the element on animation frames instead
  // of re-rendering the whole page from the hook's 4 Hz timeupdate.
  useEffect(() => {
    if (!isPlaying) return undefined;
    let frame = 0;
    const tick = () => {
      setLiveTime(getCurrentTime());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, getCurrentTime]);

  // Drop any in-progress scrub when the source changes.
  useEffect(() => {
    setScrubValue(null);
    pointerDownRef.current = false;
  }, [status]);

  if (status === 'idle') return null;

  const base = `flex items-center gap-3 px-4 py-2 border-b border-gray-200 bg-white text-sm ${className ?? ''}`;

  if (status === 'loading') {
    return (
      <div className={base} data-testid="audio-player-loading">
        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
        <span className="text-gray-500">Loading recording...</span>
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className={base} data-testid="audio-player-unavailable">
        <VolumeX className="h-4 w-4 text-gray-400" />
        <span className="text-gray-500">No local recording for this meeting.</span>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={base} data-testid="audio-player-error">
        <AlertCircle className="h-4 w-4 text-red-500" />
        <span className="flex-1 truncate text-red-700" title={error ?? undefined}>
          {error ?? 'The recording could not be played'}
        </span>
        <button
          type="button"
          onClick={player.reload}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    );
  }

  const position = isPlaying ? liveTime : currentTime;
  const shownTime = scrubValue ?? position;
  const sliderMax = duration > 0 ? duration : Math.max(position, 1);

  const commitScrub = (value: number) => {
    setScrubValue(null);
    void player.seek(value);
  };

  return (
    <div className={base} data-testid="audio-player" role="group" aria-label="Recording playback">
      <button
        type="button"
        onClick={() => void player.toggle()}
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        aria-label={isPlaying ? 'Pause' : 'Play'}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>

      <span className="w-12 flex-shrink-0 text-right font-mono text-xs tabular-nums text-gray-600">
        {formatPlayerTime(shownTime)}
      </span>

      <input
        type="range"
        min={0}
        max={sliderMax}
        step={0.1}
        value={Math.min(shownTime, sliderMax)}
        aria-label="Seek"
        aria-valuetext={`${formatPlayerTime(shownTime)} of ${formatPlayerTime(duration)}`}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-blue-600"
        onPointerDown={() => {
          pointerDownRef.current = true;
        }}
        onPointerUp={(event) => {
          if (!pointerDownRef.current) return;
          pointerDownRef.current = false;
          commitScrub(Number((event.target as HTMLInputElement).value));
        }}
        onPointerCancel={() => {
          pointerDownRef.current = false;
          setScrubValue(null);
        }}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (pointerDownRef.current) {
            setScrubValue(value); // preview while dragging, seek on release
          } else {
            commitScrub(value); // keyboard nudges seek immediately
          }
        }}
      />

      <span className="w-12 flex-shrink-0 font-mono text-xs tabular-nums text-gray-500">
        {formatPlayerTime(duration)}
      </span>
    </div>
  );
}
