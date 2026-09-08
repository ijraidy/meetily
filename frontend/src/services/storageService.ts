/**
 * Storage Service
 *
 * Handles all meeting storage and retrieval Tauri backend calls (SQLite persistence).
 * Thin wrapper over the Tauri commands, plus an idempotency layer for
 * `saveMeeting`: the backend `api_save_transcript` command always INSERTs a
 * brand-new `meetings` row, so every caller that can run twice for the same
 * recording (two `useRecordingStop` instances, a tray stop racing a UI stop,
 * a retried save) must pass the recording's session key so the second call
 * returns the first call's meeting instead of creating a duplicate.
 */

import { invoke } from '@tauri-apps/api/core';
import { Transcript } from '@/types';

export interface SaveMeetingRequest {
  meetingTitle: string;
  transcripts: Transcript[];
  folderPath: string | null;
}

export interface SaveMeetingResponse {
  meeting_id: string;
}

export interface SaveMeetingOptions {
  /**
   * Stable key for the recording being saved (backend `session_id`, or the
   * recording folder). Saves with the same key are collapsed: a concurrent
   * call joins the in-flight save, a later call returns the stored result.
   */
  idempotencyKey?: string;
}

export interface Meeting {
  id: string;
  title: string;
  [key: string]: any; // Allow additional properties from backend
}

/**
 * Storage Service
 * Singleton service for managing meeting storage operations
 */
export class StorageService {
  /** Saves currently running, keyed by idempotency key. */
  private inflightSaves = new Map<string, Promise<SaveMeetingResponse>>();
  /** Saves that already succeeded this session, keyed by idempotency key. */
  private completedSaves = new Map<string, SaveMeetingResponse>();

  /**
   * Save meeting transcript to SQLite database
   * @param meetingTitle - Title of the meeting
   * @param transcripts - Array of transcript segments
   * @param folderPath - Optional folder path for audio file
   * @param options - Optional idempotency key (see `SaveMeetingOptions`)
   * @returns Promise with { meeting_id: string }
   */
  async saveMeeting(
    meetingTitle: string,
    transcripts: Transcript[],
    folderPath: string | null,
    options: SaveMeetingOptions = {}
  ): Promise<SaveMeetingResponse> {
    const key = options.idempotencyKey?.trim() || null;
    if (!key) {
      return this.invokeSave(meetingTitle, transcripts, folderPath);
    }

    const done = this.completedSaves.get(key);
    if (done) {
      console.warn(`[storageService] saveMeeting(${key}) already completed as ${done.meeting_id} - returning it instead of inserting a duplicate`);
      return done;
    }

    const inflight = this.inflightSaves.get(key);
    if (inflight) {
      console.warn(`[storageService] saveMeeting(${key}) already in flight - joining it instead of inserting a duplicate`);
      return inflight;
    }

    // Claim the key synchronously (before the first await) so two callers in
    // the same tick cannot both miss the maps.
    const save = this.invokeSave(meetingTitle, transcripts, folderPath)
      .then((response) => {
        this.completedSaves.set(key, response);
        return response;
      })
      .finally(() => {
        this.inflightSaves.delete(key);
      });
    this.inflightSaves.set(key, save);
    return save;
  }

  /**
   * True when a save with this idempotency key already succeeded (or is running).
   */
  hasSavedMeeting(idempotencyKey: string): boolean {
    return this.completedSaves.has(idempotencyKey) || this.inflightSaves.has(idempotencyKey);
  }

  /**
   * Meeting id produced by an earlier save with this key, if any.
   */
  getSavedMeetingId(idempotencyKey: string): string | null {
    return this.completedSaves.get(idempotencyKey)?.meeting_id ?? null;
  }

  private invokeSave(
    meetingTitle: string,
    transcripts: Transcript[],
    folderPath: string | null
  ): Promise<SaveMeetingResponse> {
    return invoke<SaveMeetingResponse>('api_save_transcript', {
      meetingTitle,
      transcripts,
      folderPath,
    });
  }

  /**
   * Get meeting details by ID
   * @param meetingId - ID of the meeting to fetch
   * @returns Promise with meeting details
   */
  async getMeeting(meetingId: string): Promise<Meeting> {
    return invoke<Meeting>('api_get_meeting', { meetingId });
  }

  /**
   * Get list of all meetings
   * @returns Promise with array of meetings
   */
  async getMeetings(): Promise<Meeting[]> {
    return invoke<Meeting[]>('api_get_meetings');
  }
}

// Export singleton instance
export const storageService = new StorageService();
