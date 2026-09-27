import { randomUUID } from "node:crypto";
import { assertTrustedBlobUrl } from "./blob-url";
import { db } from "./db";
import type { MeetingSummary } from "./summary";
import type { Meeting, MeetingSource, MeetingStatus } from "./types";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  language: string | null;
  duration: number | null;
  segments: TranscriptSegment[];
}

export async function createMeeting(input: {
  title: string;
  source: MeetingSource;
  audioFilename?: string | null;
  audioMime?: string | null;
  audioBytes?: number | null;
  durationSeconds?: number | null;
  audioUrl?: string | null;
  audioBlob?: Uint8Array | null;
}): Promise<Meeting> {
  const client = await db();
  const now = new Date().toISOString();
  const id = randomUUID();

  await client.execute({
    sql: `INSERT INTO meetings (
            id, title, source, audio_filename, audio_mime, audio_bytes,
            duration_seconds, status, status_error, transcript,
            transcript_language, summary_json, audio_blob, audio_url,
            transcript_segments_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?)`,
    args: [
      id,
      input.title,
      input.source,
      input.audioFilename ?? null,
      input.audioMime ?? null,
      input.audioBytes ?? null,
      input.durationSeconds ?? null,
      "uploaded",
      input.audioBlob ?? null,
      input.audioUrl ?? null,
      now,
      now,
    ],
  });

  return requireMeeting(id);
}

/** Everything except `audio_blob`, for a single-meeting read. */
const PUBLIC_COLUMNS = `id, title, source, audio_filename, audio_mime, audio_bytes,
       duration_seconds, status, status_error, transcript, transcript_language,
       summary_json, audio_url, transcript_sampled, created_at, updated_at`;

/**
 * The dashboard only renders title, metadata, status and the summary, so listing
 * every full transcript would pull the entire corpus into memory for nothing.
 * On a 100-meeting account that is the difference between a few KB and a few MB.
 */
const CARD_COLUMNS = `id, title, source, audio_filename, audio_mime, audio_bytes,
       duration_seconds, status, status_error, transcript_language, summary_json,
       created_at, updated_at`;
export async function getMeeting(id: string): Promise<Meeting | null> {
  const client = await db();
  const result = await client.execute({
    sql: `SELECT ${PUBLIC_COLUMNS} FROM meetings WHERE id = ?`,
    args: [id],
  });
  return (result.rows[0] as unknown as Meeting) ?? null;
}

export async function requireMeeting(id: string): Promise<Meeting> {
  const meeting = await getMeeting(id);
  if (!meeting) throw new NotFoundError(id);
  return meeting;
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`No meeting with id ${id}`);
    this.name = "NotFoundError";
  }
}

export interface AudioSource {
  bytes: Uint8Array;
  filename: string;
  mimeType: string | null;
  /** True when the bytes came from blob storage rather than the legacy column. */
  fromBlob: boolean;
}

/**
 * Resolves a meeting's audio to bytes.
 *
 * Current meetings point at blob storage and are fetched over https. Rows
 * created before the blob migration still carry the bytes in `audio_blob` and
 * are read from there, so no existing meeting becomes untranscribable.
 */
export async function loadAudio(meeting: Meeting): Promise<AudioSource | null> {
  const filename = meeting.audio_filename || "audio.webm";

  if (meeting.audio_url) {
    const trusted = assertTrustedBlobUrl(meeting.audio_url);
    const response = await fetch(trusted);

    if (!response.ok) {
      throw new Error(
        `Could not read the stored audio (HTTP ${response.status}). ` +
          "The blob may have been deleted, in which case the meeting must be re-uploaded.",
      );
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      bytes: buffer,
      filename,
      mimeType: meeting.audio_mime,
      fromBlob: true,
    };
  }

  const stored = await getLegacyAudioBlob(meeting.id);
  if (!stored) return null;

  return {
    bytes: stored,
    filename,
    mimeType: meeting.audio_mime,
    fromBlob: false,
  };
}

/** Reads the pre-blob `audio_blob` column. */
async function getLegacyAudioBlob(id: string): Promise<Uint8Array | null> {
  const client = await db();
  const result = await client.execute({
    sql: `SELECT audio_blob FROM meetings WHERE id = ?`,
    args: [id],
  });

  const value: unknown = result.rows[0]?.audio_blob;
  if (value === null || value === undefined) return null;
  // The driver hands BLOBs back as ArrayBuffer; older paths may yield a view.
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`Unexpected audio_blob representation: ${typeof value}`);
}

export async function setStatus(
  id: string,
  status: MeetingStatus,
  error?: string | null,
): Promise<void> {
  const client = await db();
  await client.execute({
    sql: `UPDATE meetings SET status = ?, status_error = ?, updated_at = ? WHERE id = ?`,
    args: [status, error ?? null, new Date().toISOString(), id],
  });
}

export async function saveTranscript(
  id: string,
  transcript: Transcript,
): Promise<void> {
  const client = await db();
  await client.execute({
    sql: `UPDATE meetings
          SET transcript = ?, transcript_language = ?, duration_seconds = COALESCE(?, duration_seconds),
              transcript_segments_json = ?, status = ?, status_error = NULL, updated_at = ?
          WHERE id = ?`,
    args: [
      transcript.text,
      transcript.language,
      transcript.duration,
      JSON.stringify(transcript.segments),
      "transcribed",
      new Date().toISOString(),
      id,
    ],
  });
}

export async function getSegments(id: string): Promise<TranscriptSegment[]> {
  const client = await db();
  const result = await client.execute({
    sql: `SELECT transcript_segments_json FROM meetings WHERE id = ?`,
    args: [id],
  });

  const raw: unknown = result.rows[0]?.transcript_segments_json;
  if (typeof raw !== "string" || raw.length === 0) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (segment): segment is TranscriptSegment =>
          typeof segment === "object" &&
          segment !== null &&
          typeof (segment as TranscriptSegment).start === "number" &&
          typeof (segment as TranscriptSegment).end === "number" &&
          typeof (segment as TranscriptSegment).text === "string",
      )
      .map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
      }));
  } catch {
    return [];
  }
}

export async function saveSummary(
  id: string,
  summary: MeetingSummary,
  coverage: { sampled: boolean; segmentsUsed: number; segmentsTotal: number },
): Promise<void> {
  const client = await db();
  await client.execute({
    sql: `UPDATE meetings
          SET summary_json = ?, transcript_sampled = ?, status = 'ready',
              status_error = NULL, updated_at = ?
          WHERE id = ?`,
    args: [
      JSON.stringify(summary),
      coverage.sampled ? 1 : 0,
      new Date().toISOString(),
      id,
    ],
  });
}

export async function listMeetings(): Promise<Meeting[]> {
  const client = await db();
  const result = await client.execute(
    `SELECT ${CARD_COLUMNS} FROM meetings ORDER BY created_at DESC`,
  );
  return result.rows as unknown as Meeting[];
}
