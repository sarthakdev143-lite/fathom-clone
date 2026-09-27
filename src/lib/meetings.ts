import { randomUUID } from "node:crypto";
import { db } from "./db";
import type {
  Meeting,
  MeetingSource,
  MeetingStatus,
} from "./types";

export async function createMeeting(input: {
  title: string;
  source: MeetingSource;
  audioFilename?: string | null;
  audioMime?: string | null;
  audioBytes?: number | null;
  durationSeconds?: number | null;
  status?: MeetingStatus;
}): Promise<Meeting> {
  const client = await db();
  const now = new Date().toISOString();
  const id = randomUUID();

  await client.execute({
    sql: `INSERT INTO meetings (
            id, title, source, audio_filename, audio_mime, audio_bytes,
            duration_seconds, status, status_error, transcript,
            transcript_language, summary_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    args: [
      id,
      input.title,
      input.source,
      input.audioFilename ?? null,
      input.audioMime ?? null,
      input.audioBytes ?? null,
      input.durationSeconds ?? null,
      input.status ?? "uploaded",
      now,
      now,
    ],
  });

  return getMeeting(id).then((m) => {
    if (!m) throw new Error("Meeting row vanished immediately after insert");
    return m;
  });
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  const client = await db();
  const result = await client.execute({
    sql: `SELECT * FROM meetings WHERE id = ?`,
    args: [id],
  });
  return (result.rows[0] as unknown as Meeting) ?? null;
}

export async function listMeetings(): Promise<Meeting[]> {
  const client = await db();
  const result = await client.execute(
    `SELECT * FROM meetings ORDER BY created_at DESC`,
  );
  return result.rows as unknown as Meeting[];
}
