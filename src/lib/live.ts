import { randomUUID } from "node:crypto";
import { db } from "./db";
import { getMeeting, type TranscriptSegment } from "./meetings";
import type { ActionItem } from "./summary";
import type { Meeting, MeetingStatus } from "./types";

/**
 * Live mode state, held on the same `meetings` row as the finished meeting so a
 * live session and its final transcript are one object rather than two that must
 * be reconciled.
 *
 * Transport is polling, not Server-Sent Events. A recording can run for half an
 * hour, and a Vercel function is killed once it exceeds its duration limit, so a
 * long-lived SSE connection cannot survive a meeting. Polling every couple of
 * seconds costs nothing extra and is bounded per request.
 */

export interface LiveSummary {
  tldr: string;
  topics: string[];
  decisions: string[];
  action_items: ActionItem[];
}

/**
 * How much new audio has to arrive before the provisional summary is refreshed.
 * It grows with the meeting: early on the summary changes a lot and the user
 * is watching it form, later a one-minute or two-minute refresh reads the same
 * and costs a fraction of the calls.
 */
export function summaryRefreshSeconds(audioSeconds: number): number {
  if (audioSeconds < 10 * 60) return 35;
  if (audioSeconds < 30 * 60) return 60;
  return 120;
}

/** Client polls only for what changed since these counters. */
export interface LiveDelta {
  status: MeetingStatus;
  liveSeq: number;
  summarySeq: number;
  audioSeconds: number;
  /** Only segments the poller has not seen. */
  segments: TranscriptSegment[];
  /** Present only when the summary has changed since `sinceSummary`. */
  summary: LiveSummary | null;
  sampled: boolean;
  error: string | null;
}

function toLiveDelta(
  row: Record<string, unknown>,
  segments: TranscriptSegment[],
  sinceSegment: number,
  sinceSummary: number,
): LiveDelta {
  const liveSeq = Number(row.live_seq ?? 0);
  const summarySeq = Number(row.live_summary_seq ?? 0);

  let summary: LiveSummary | null = null;
  if (summarySeq > sinceSummary && typeof row.summary_json === "string") {
    try {
      const parsed = JSON.parse(row.summary_json) as LiveSummary;
      if (parsed && typeof parsed.tldr === "string") summary = parsed;
    } catch {
      summary = null;
    }
  }

  return {
    status: row.status as MeetingStatus,
    liveSeq,
    summarySeq,
    audioSeconds: Number(row.live_audio_seconds ?? 0),
    // The poller tracks how many segments it has, and asks for the tail only.
    segments: Number.isFinite(sinceSegment) ? segments.slice(sinceSegment) : segments,
    summary,
    sampled: row.transcript_sampled === 1,
    error: (row.status_error as string | null) ?? null,
  };
}

const LIVE_COLUMNS = `id, status, status_error, summary_json, live_seq,
       live_summary_seq, live_audio_seconds, transcript_sampled, updated_at`;

export async function createLiveMeeting(title: string): Promise<string> {
  const client = await db();
  const now = new Date().toISOString();
  const id = randomUUID();

  await client.execute({
    sql: `INSERT INTO meetings (
            id, title, source, status, status_error, transcript,
            transcript_language, summary_json, live_seq, live_summary_seq,
            live_audio_seconds, created_at, updated_at
          ) VALUES (?, ?, 'recording', 'live', NULL, NULL, NULL, NULL, 0, 0, 0, ?, ?)`,
    args: [id, title, now, now],
  });

  return id;
}

/**
 * Appends freshly transcribed segments and returns the meeting's current live
 * state. Existing segments are re-read and rewritten because the summary pass
 * needs the whole transcript; at ~35 KB for a 30-minute meeting this is cheap.
 */
export async function appendLiveSegments(input: {
  id: string;
  segments: TranscriptSegment[];
  /** Total audio consumed so far, in seconds. */
  audioSeconds: number;
  language: string | null;
}): Promise<void> {
  const client = await db();
  const meeting = await getMeeting(input.id);
  if (!meeting) throw new Error(`No live meeting with id ${input.id}`);

  const existing = await readSegments(input.id);
  const merged = [...existing, ...input.segments];

  await client.execute({
    sql: `UPDATE meetings
          SET transcript_segments_json = ?, transcript = ?, transcript_language = ?,
              live_audio_seconds = ?, live_seq = live_seq + 1, updated_at = ?
          WHERE id = ?`,
    args: [
      JSON.stringify(merged),
      merged.map((s) => s.text).join(" "),
      input.language,
      input.audioSeconds,
      new Date().toISOString(),
      input.id,
    ],
  });
}

export async function setLiveSummary(
  id: string,
  summary: LiveSummary,
  sampled: boolean,
  audioSeconds: number,
): Promise<void> {
  const client = await db();
  await client.execute({
    sql: `UPDATE meetings
          SET summary_json = ?, transcript_sampled = ?,
              live_summary_seq = live_summary_seq + 1,
              live_summary_audio_seconds = ?, updated_at = ?
          WHERE id = ?`,
    args: [
      JSON.stringify(summary),
      sampled ? 1 : 0,
      audioSeconds,
      new Date().toISOString(),
      id,
    ],
  });
}

/**
 * True when enough new audio has arrived since the last live summary to be worth
 * another model call. Derived from the database so it is correct regardless of
 * which instance serves the request.
 */
export async function isSummaryDue(
  id: string,
  audioSeconds: number,
): Promise<boolean> {
  const client = await db();
  const result = await client.execute({
    sql: `SELECT live_summary_seq, live_summary_audio_seconds FROM meetings WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return false;

  // Always produce one summary early, so the panel is not empty for a minute.
  if (Number(row.live_summary_seq ?? 0) === 0) return true;

  const lastAt = Number(row.live_summary_audio_seconds ?? 0);
  return audioSeconds - lastAt >= summaryRefreshSeconds(audioSeconds);
}

/** What the rolling summary needs: the previous one and where it stopped. */
export async function readLiveSummaryState(
  id: string,
): Promise<{ previous: LiveSummary | null; coveredSeconds: number }> {
  const client = await db();
  const result = await client.execute({
    sql: `SELECT summary_json, live_summary_audio_seconds FROM meetings WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  let previous: LiveSummary | null = null;
  if (typeof row?.summary_json === "string") {
    try {
      const parsed = JSON.parse(row.summary_json) as LiveSummary;
      if (parsed && typeof parsed.tldr === "string") previous = parsed;
    } catch {
      previous = null;
    }
  }
  return { previous, coveredSeconds: Number(row?.live_summary_audio_seconds ?? 0) };
}

/**
 * Keeps a live row from being swept as abandoned while the browser is still
 * polling. Writes at most once a minute, so a 2-second poll is not a 2-second
 * write.
 */
export async function touchLiveMeeting(id: string): Promise<void> {
  const client = await db();
  const now = new Date();
  await client.execute({
    sql: `UPDATE meetings SET updated_at = ?
           WHERE id = ? AND status = 'live' AND updated_at < ?`,
    args: [now.toISOString(), id, new Date(now.getTime() - 60_000).toISOString()],
  });
}

export async function readSegments(id: string): Promise<TranscriptSegment[]> {
  const client = await db();
  const result = await client.execute({
    sql: `SELECT transcript_segments_json FROM meetings WHERE id = ?`,
    args: [id],
  });
  const raw: unknown = result.rows[0]?.transcript_segments_json;
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TranscriptSegment[]) : [];
  } catch {
    return [];
  }
}

export async function getLiveDelta(input: {
  id: string;
  sinceSegment: number;
  sinceSummary: number;
}): Promise<LiveDelta | null> {
  const client = await db();
  const result = await client.execute({
    sql: `SELECT ${LIVE_COLUMNS} FROM meetings WHERE id = ?`,
    args: [input.id],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const segments = await readSegments(input.id);
  return toLiveDelta(row, segments, input.sinceSegment, input.sinceSummary);
}

/**
 * Ends the live phase. The meeting moves to `uploaded` so the existing
 * transcription and summarization endpoints take it from here unchanged: the
 * live transcript is a preview, and the authoritative one is produced by
 * re-transcribing the complete audio.
 */
export async function finishLiveMeeting(input: {
  id: string;
  audioUrl: string;
  filename: string;
  mime: string;
  size: number;
  durationSeconds: number | null;
}): Promise<void> {
  const client = await db();
  const result = await client.execute({
    sql: `UPDATE meetings
          SET status = 'uploaded', status_error = NULL, audio_url = ?,
              audio_filename = ?, audio_mime = ?, audio_bytes = ?,
              duration_seconds = COALESCE(?, duration_seconds),
              live_seq = live_seq + 1, updated_at = ?
          WHERE id = ?`,
    args: [
      input.audioUrl,
      input.filename,
      input.mime,
      input.size,
      input.durationSeconds,
      new Date().toISOString(),
      input.id,
    ],
  });
  if (Number(result.rowsAffected ?? 0) === 0) {
    throw new Error(`No live meeting with id ${input.id}`);
  }
}

export async function setLiveError(id: string, message: string): Promise<void> {
  const client = await db();
  await client.execute({
    sql: `UPDATE meetings SET status_error = ?, live_seq = live_seq + 1, updated_at = ? WHERE id = ?`,
    args: [message, new Date().toISOString(), id],
  });
}
