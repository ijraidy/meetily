import { invoke } from '@tauri-apps/api/core';
import type { PaginatedTranscriptsResponse, Transcript } from '@/types';

/**
 * Fetches every transcript segment for a meeting from the local database,
 * regardless of what the paginated UI currently has loaded. Throws on failure.
 */
export async function fetchAllMeetingTranscripts(meetingId: string): Promise<Transcript[]> {
  const firstPage = await invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', {
    meetingId,
    limit: 1,
    offset: 0,
  });

  const totalCount = firstPage.total_count;
  if (!totalCount) {
    return [];
  }

  const all = await invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', {
    meetingId,
    limit: totalCount,
    offset: 0,
  });

  return all.transcripts;
}
