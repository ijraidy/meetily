/**
 * Pure formatting helpers for exporting a meeting to files. Kept free of
 * React and Tauri so they can be unit-tested in Node.
 */

export interface ExportableSegment {
  text: string;
  /** Seconds from recording start. */
  audio_start_time?: number;
  audio_end_time?: number;
  /** Wall-clock fallback used when no recording-relative time exists. */
  timestamp?: string;
}

export interface ExportMeetingInfo {
  title: string;
  /** ISO date/time string (or anything Date can parse). */
  createdAt?: string | Date | null;
}

export type ExportKind = 'summary-md' | 'transcript-txt' | 'transcript-srt' | 'combined-md';

export interface ExportTarget {
  extension: 'md' | 'txt' | 'srt';
  filterName: string;
  suffix: string;
}

export const EXPORT_TARGETS: Record<ExportKind, ExportTarget> = {
  'summary-md': { extension: 'md', filterName: 'Markdown', suffix: 'summary' },
  'transcript-txt': { extension: 'txt', filterName: 'Text', suffix: 'transcript' },
  'transcript-srt': { extension: 'srt', filterName: 'SubRip subtitles', suffix: 'transcript' },
  'combined-md': { extension: 'md', filterName: 'Markdown', suffix: 'notes' },
};

/** `mm:ss`, or `h:mm:ss` once an hour has passed. */
export function formatClockTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** `HH:MM:SS,mmm` as required by SubRip. */
export function formatSrtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Human-readable date for document headers. */
export function formatExportDate(value: string | Date | null | undefined): string {
  const date = parseDate(value);
  if (!date) return 'Unknown date';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `YYYY-MM-DD` in local time, for file names. */
export function formatFileDate(value: string | Date | null | undefined): string {
  const date = parseDate(value) ?? new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Strips characters that are illegal in Windows/macOS/Linux file names. */
export function sanitizeFileName(name: string, fallback = 'meeting'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
  const limited = cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned;
  return limited || fallback;
}

/** `<title>_<YYYY-MM-DD>_<suffix>.<ext>` */
export function buildExportFileName(
  meeting: ExportMeetingInfo,
  suffix: string,
  extension: string,
): string {
  const parts = [sanitizeFileName(meeting.title), formatFileDate(meeting.createdAt)];
  if (suffix) parts.push(suffix);
  return `${parts.join('_')}.${extension.replace(/^\./, '')}`;
}

function segmentLabel(segment: ExportableSegment): string {
  if (typeof segment.audio_start_time === 'number' && Number.isFinite(segment.audio_start_time)) {
    return `[${formatClockTime(segment.audio_start_time)}]`;
  }
  return segment.timestamp ? `[${segment.timestamp}]` : '[--:--]';
}

/** One `[mm:ss] text` line per segment. */
export function transcriptLines(segments: ExportableSegment[]): string[] {
  return segments
    .filter((segment) => segment.text && segment.text.trim().length > 0)
    .map((segment) => `${segmentLabel(segment)} ${segment.text.trim()}`);
}

/** Plain-text transcript with a short header. */
export function transcriptToText(segments: ExportableSegment[], meeting: ExportMeetingInfo): string {
  const header = [meeting.title, `Date: ${formatExportDate(meeting.createdAt)}`, ''];
  return `${[...header, ...transcriptLines(segments)].join('\n')}\n`;
}

/**
 * SubRip subtitles. Segments without timing fall back to the previous end
 * time; a missing end time uses the next segment's start (or +4 s).
 */
export function transcriptToSrt(segments: ExportableSegment[]): string {
  const cues: string[] = [];
  let cursor = 0;
  let index = 1;
  const usable = segments.filter((segment) => segment.text && segment.text.trim().length > 0);

  for (let i = 0; i < usable.length; i += 1) {
    const segment = usable[i];
    const next = usable[i + 1];
    const hasStart = typeof segment.audio_start_time === 'number' && Number.isFinite(segment.audio_start_time);
    const start = hasStart ? Math.max(0, segment.audio_start_time as number) : cursor;

    let end: number;
    if (typeof segment.audio_end_time === 'number' && Number.isFinite(segment.audio_end_time)) {
      end = segment.audio_end_time;
    } else if (next && typeof next.audio_start_time === 'number' && Number.isFinite(next.audio_start_time)) {
      end = next.audio_start_time;
    } else {
      end = start + 4;
    }
    if (end <= start) end = start + 1;

    cues.push(`${index}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${segment.text.trim()}\n`);
    cursor = end;
    index += 1;
  }

  return cues.join('\n');
}

/** Markdown document for the AI summary. */
export function summaryToMarkdown(summaryMarkdown: string, meeting: ExportMeetingInfo): string {
  const body = summaryMarkdown.trim();
  return `# ${meeting.title}\n\n**Date:** ${formatExportDate(meeting.createdAt)}\n\n---\n\n${body}\n`;
}

/** Summary followed by the transcript in a single Markdown document. */
export function combinedMarkdown(
  summaryMarkdown: string | null,
  segments: ExportableSegment[],
  meeting: ExportMeetingInfo,
): string {
  const sections: string[] = [
    `# ${meeting.title}`,
    '',
    `**Date:** ${formatExportDate(meeting.createdAt)}`,
    '',
    '---',
    '',
    '## Summary',
    '',
    summaryMarkdown && summaryMarkdown.trim() ? summaryMarkdown.trim() : '_No summary has been generated for this meeting._',
    '',
    '## Transcript',
    '',
  ];
  const lines = transcriptLines(segments);
  if (lines.length === 0) {
    sections.push('_No transcript available._');
  } else {
    // Two trailing spaces force a line break in Markdown.
    sections.push(...lines.map((line) => `${line}  `));
  }
  return `${sections.join('\n')}\n`;
}

/**
 * Converts the legacy `{ section: { title, blocks } }` summary shape into
 * Markdown. Returns an empty string when nothing usable is present.
 */
export function legacySummaryToMarkdown(summary: unknown): string {
  if (!summary || typeof summary !== 'object') return '';
  const skip = new Set(['markdown', 'summary_json', '_section_order', 'MeetingName', 'reasoning_stripped', 'normalization_fallback']);
  const entries = Object.entries(summary as Record<string, unknown>).filter(([key]) => !skip.has(key));
  const order = (summary as { _section_order?: unknown })._section_order;
  if (Array.isArray(order)) {
    const rank = new Map(order.map((key, i) => [String(key), i]));
    entries.sort(([a], [b]) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
  }
  return entries
    .map(([, section]) => {
      if (!section || typeof section !== 'object') return '';
      const { title, blocks } = section as { title?: unknown; blocks?: unknown };
      if (typeof title !== 'string' || !Array.isArray(blocks)) return '';
      const items = blocks
        .map((block) => {
          const content = block && typeof block === 'object' ? (block as { content?: unknown }).content : null;
          return typeof content === 'string' && content.trim() ? `- ${content.trim()}` : '';
        })
        .filter(Boolean);
      return items.length ? `## ${title}\n\n${items.join('\n')}` : '';
    })
    .filter((section) => section.trim())
    .join('\n\n');
}
