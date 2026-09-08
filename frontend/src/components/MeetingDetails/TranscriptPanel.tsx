"use client";

import { Transcript, TranscriptSegmentData } from '@/types';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { AudioPlayer } from '@/components/AudioPlayer';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import type { ExportKind } from '@/lib/export-formats';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { useCallback, useMemo } from 'react';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;

  // Export props
  onExport?: (kind: ExportKind) => void | Promise<void>;
  hasSummary?: boolean;
  isExporting?: boolean;
}

/**
 * Index of the segment that contains `time` (the last segment whose start is
 * at or before it). Segments are sorted by start time, so binary search.
 */
function findActiveSegmentIndex(segments: TranscriptSegmentData[], time: number): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].timestamp <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  onExport,
  hasSummary = false,
  isExporting = false,
}: TranscriptPanelProps) {
  // Playback of the saved recording. Never while recording: the file is still
  // being written and the live page has its own controls.
  const player = useAudioPlayer(!isRecording && meetingId ? meetingId : null);
  const { seek, status: playerStatus, currentTime: playerTime } = player;

  const handleSeek = useCallback((seconds: number) => {
    void seek(seconds, { play: true });
  }, [seek]);

  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    }));
  }, [transcripts, usePagination, segments]);

  const activeSegmentId = useMemo(() => {
    if (playerStatus !== 'ready' || convertedSegments.length === 0) return null;
    const index = findActiveSegmentIndex(convertedSegments, playerTime);
    if (index < 0) return null;
    const segment = convertedSegments[index];
    // Only highlight while inside the segment when we know where it ends.
    if (segment.endTime !== undefined && playerTime > segment.endTime + 0.5) return null;
    return segment.id;
  }, [convertedSegments, playerStatus, playerTime]);

  return (
    <div className="flex h-full min-w-0 w-full bg-white flex-col relative @container">
      {/* Title area */}
      <div className="p-4 border-b border-gray-200">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onRefetchTranscripts={onRefetchTranscripts}
          onExport={onExport}
          hasSummary={hasSummary}
          isExporting={isExporting}
        />
      </div>

      {/* Playback bar for the saved recording (hidden when there is none) */}
      <AudioPlayer player={player} />

      {/* Transcript content - use virtualized view for better performance */}
      <div className="flex-1 overflow-hidden pb-4">
        <VirtualizedTranscriptView
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence={true}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          onSeek={playerStatus === 'ready' ? handleSeek : undefined}
          activeSegmentId={activeSegmentId}
        />
      </div>

      {/* Custom prompt input at bottom of transcript section */}
      {!isRecording && convertedSegments.length > 0 && (
        <div className="p-1 border-t border-gray-200">
          <textarea
            dir="auto"
            placeholder="Add context for AI summary. For example people involved, meeting overview, objective etc..."
            className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm min-h-[80px] resize-y"
            value={customPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
