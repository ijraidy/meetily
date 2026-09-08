"use client";

import { Download, FileText, Loader2, Subtitles, FileCode, Files } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ExportKind } from '@/lib/export-formats';

interface ExportMenuProps {
  onExport: (kind: ExportKind) => void | Promise<void>;
  hasSummary: boolean;
  hasTranscript: boolean;
  isExporting?: boolean;
  disabled?: boolean;
  /** Container-query class controlling when the text label is shown. */
  labelClassName?: string;
}

export function ExportMenu({
  onExport,
  hasSummary,
  hasTranscript,
  isExporting = false,
  disabled = false,
  labelClassName = 'hidden @[22rem]:inline',
}: ExportMenuProps) {
  const nothingToExport = !hasSummary && !hasTranscript;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="px-2 @[22rem]:px-3"
          disabled={disabled || isExporting || nothingToExport}
          title={nothingToExport ? 'Nothing to export yet' : 'Export to a file'}
          aria-label="Export"
        >
          {isExporting ? <Loader2 className="animate-spin" /> : <Download />}
          <span className={labelClassName}>Export</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Export to file</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!hasSummary} onSelect={() => void onExport('summary-md')}>
          <FileCode className="mr-2 h-4 w-4" />
          <div className="flex flex-col">
            <span>Summary as Markdown</span>
            <span className="text-xs text-gray-500">.md</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hasTranscript} onSelect={() => void onExport('transcript-txt')}>
          <FileText className="mr-2 h-4 w-4" />
          <div className="flex flex-col">
            <span>Transcript as text</span>
            <span className="text-xs text-gray-500">.txt, one [mm:ss] line per segment</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hasTranscript} onSelect={() => void onExport('transcript-srt')}>
          <Subtitles className="mr-2 h-4 w-4" />
          <div className="flex flex-col">
            <span>Transcript as subtitles</span>
            <span className="text-xs text-gray-500">.srt with start/end times</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={nothingToExport} onSelect={() => void onExport('combined-md')}>
          <Files className="mr-2 h-4 w-4" />
          <div className="flex flex-col">
            <span>Summary and transcript</span>
            <span className="text-xs text-gray-500">one Markdown file</span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
