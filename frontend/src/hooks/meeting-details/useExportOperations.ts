import { useCallback, useState, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { MeetingSummary } from '@/types';
import type { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import Analytics from '@/lib/analytics';
import { fetchAllMeetingTranscripts } from '@/lib/meeting-transcripts';
import { hasVisibleSummaryContent } from '@/lib/summary-content';
import {
  EXPORT_TARGETS,
  buildExportFileName,
  combinedMarkdown,
  legacySummaryToMarkdown,
  summaryToMarkdown,
  transcriptToSrt,
  transcriptToText,
  type ExportKind,
  type ExportMeetingInfo,
} from '@/lib/export-formats';

interface UseExportOperationsProps {
  meeting: { id: string; title?: string; created_at?: string };
  meetingTitle: string;
  aiSummary: MeetingSummary | null;
  blockNoteSummaryRef: RefObject<BlockNoteSummaryViewRef>;
}

/**
 * Resolves the current summary as Markdown: the live editor first (so unsaved
 * edits are included), then the stored markdown, then the legacy section format.
 */
export async function resolveSummaryMarkdown(
  aiSummary: MeetingSummary | null,
  blockNoteSummaryRef: RefObject<BlockNoteSummaryViewRef>,
): Promise<string> {
  let markdown = '';
  if (blockNoteSummaryRef.current?.getMarkdown) {
    try {
      markdown = await blockNoteSummaryRef.current.getMarkdown();
    } catch (err) {
      console.warn('Could not read markdown from the summary editor:', err);
    }
  }
  if (!markdown.trim() && aiSummary && typeof (aiSummary as { markdown?: unknown }).markdown === 'string') {
    markdown = (aiSummary as { markdown: string }).markdown;
  }
  if (!markdown.trim() && aiSummary) {
    markdown = legacySummaryToMarkdown(aiSummary);
  }
  return markdown.trim();
}

export function useExportOperations({
  meeting,
  meetingTitle,
  aiSummary,
  blockNoteSummaryRef,
}: UseExportOperationsProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = useCallback(async (kind: ExportKind) => {
    if (isExporting) return;
    setIsExporting(true);
    Analytics.trackButtonClick(`export_${kind}`, 'meeting_details');

    const info: ExportMeetingInfo = {
      title: (meetingTitle || meeting.title || 'Meeting').trim() || 'Meeting',
      createdAt: meeting.created_at ?? null,
    };
    const target = EXPORT_TARGETS[kind];

    try {
      let contents: string;

      switch (kind) {
        case 'summary-md': {
          if (!hasVisibleSummaryContent(aiSummary)) {
            toast.error('No summary to export yet');
            return;
          }
          const markdown = await resolveSummaryMarkdown(aiSummary, blockNoteSummaryRef);
          if (!markdown) {
            toast.error('No summary to export yet');
            return;
          }
          contents = summaryToMarkdown(markdown, info);
          break;
        }
        case 'transcript-txt':
        case 'transcript-srt': {
          const transcripts = await fetchAllMeetingTranscripts(meeting.id);
          if (transcripts.length === 0) {
            toast.error('No transcript to export');
            return;
          }
          contents = kind === 'transcript-txt'
            ? transcriptToText(transcripts, info)
            : transcriptToSrt(transcripts);
          break;
        }
        case 'combined-md': {
          const [transcripts, markdown] = await Promise.all([
            fetchAllMeetingTranscripts(meeting.id),
            hasVisibleSummaryContent(aiSummary)
              ? resolveSummaryMarkdown(aiSummary, blockNoteSummaryRef)
              : Promise.resolve(''),
          ]);
          if (transcripts.length === 0 && !markdown) {
            toast.error('Nothing to export yet');
            return;
          }
          contents = combinedMarkdown(markdown || null, transcripts, info);
          break;
        }
        default:
          return;
      }

      const savedPath = await invoke<string | null>('export_text_file', {
        defaultFileName: buildExportFileName(info, target.suffix, target.extension),
        extension: target.extension,
        filterName: target.filterName,
        contents,
      });

      if (savedPath) {
        toast.success('Exported', { description: savedPath });
      }
    } catch (error) {
      console.error('Export failed:', error);
      toast.error(typeof error === 'string' ? error : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  }, [isExporting, meeting.id, meeting.title, meeting.created_at, meetingTitle, aiSummary, blockNoteSummaryRef]);

  return { handleExport, isExporting };
}
