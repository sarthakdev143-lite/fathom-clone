import { db } from "./db";
import { errorFields, logEvent } from "./log";

/**
 * Housekeeping for meetings that will never finish on their own.
 *
 *   - A `live` row whose browser went away (tab closed, laptop slept) stays
 *     `live` forever, because nothing server-side knows the tab is gone. The
 *     poller heartbeats once a minute, so ten minutes of silence is certain.
 *     The partial live transcript is kept and can be summarised from the
 *     meeting page.
 *   - A `transcribing`/`summarizing` row whose request was killed and never
 *     re-driven. Its progress is kept, so Retry resumes rather than restarts.
 *
 * Runs lazily on page loads (cheap: two indexed UPDATEs) and daily from cron.
 */

export const LIVE_STALE_MS = 10 * 60 * 1000;
export const PROCESSING_STALE_MS = 15 * 60 * 1000;

export const INTERRUPTED_WITH_TRANSCRIPT =
  "Recording was interrupted: the browser stopped sending audio before the " +
  "recording was saved, so there is no audio file. The live transcript captured " +
  "up to that point is kept and can be summarised.";

export const INTERRUPTED_EMPTY =
  "Recording was interrupted before any audio or transcript was saved.";

export const PROCESSING_STALLED =
  "Processing stopped before it finished (the server request was interrupted). " +
  "Retry to continue from where it stopped.";

export interface SweepResult {
  interruptedLive: number;
  stalled: number;
  rateLimitRowsDeleted: number;
}

export async function sweepStaleMeetings(now = Date.now()): Promise<SweepResult> {
  const client = await db();
  const nowIso = new Date(now).toISOString();

  const live = await client.execute({
    sql: `UPDATE meetings
             SET status = 'failed',
                 status_error = CASE
                   WHEN transcript IS NOT NULL AND TRIM(transcript) != '' THEN ?
                   ELSE ?
                 END,
                 updated_at = ?
           WHERE status = 'live' AND updated_at < ?`,
    args: [
      INTERRUPTED_WITH_TRANSCRIPT,
      INTERRUPTED_EMPTY,
      nowIso,
      new Date(now - LIVE_STALE_MS).toISOString(),
    ],
  });

  const stalled = await client.execute({
    sql: `UPDATE meetings
             SET status = 'failed', status_error = ?, updated_at = ?
           WHERE status IN ('transcribing', 'summarizing')
             AND updated_at < ?
             AND (lease_until IS NULL OR lease_until < ?)`,
    args: [PROCESSING_STALLED, nowIso, new Date(now - PROCESSING_STALE_MS).toISOString(), now],
  });

  const limits = await client.execute({
    sql: `DELETE FROM rate_limits WHERE window_start < ?`,
    args: [Math.floor(now / 1000) - 24 * 60 * 60],
  });

  const result = {
    interruptedLive: Number(live.rowsAffected ?? 0),
    stalled: Number(stalled.rowsAffected ?? 0),
    rateLimitRowsDeleted: Number(limits.rowsAffected ?? 0),
  };

  if (result.interruptedLive > 0 || result.stalled > 0) {
    logEvent("info", "sweep.meetings", result);
  }
  return result;
}

/** Page-load variant: never lets housekeeping break a render. */
export async function sweepQuietly(): Promise<void> {
  try {
    await sweepStaleMeetings();
  } catch (err) {
    logEvent("warn", "sweep.failed", errorFields(err));
  }
}

/** Blobs younger than this might belong to an upload still being finalised. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DELETES_PER_RUN = 500;

/**
 * Deletes uploaded audio that no meeting refers to - an upload whose
 * create-meeting call never arrived, say. Conservative on purpose: only the
 * `audio/` prefix, only blobs over a day old, and if the reference list
 * cannot be read the run aborts rather than treating everything as orphaned.
 */
export interface BlobStore {
  list: (opts: { prefix: string; cursor?: string; limit: number }) => Promise<{
    blobs: { url: string; uploadedAt: Date }[];
    cursor?: string;
    hasMore: boolean;
  }>;
  del: (urls: string[]) => Promise<void>;
}

async function vercelBlobStore(): Promise<BlobStore> {
  const mod = await import("@vercel/blob");
  return {
    list: (opts) => mod.list(opts),
    del: (urls) => mod.del(urls),
  };
}

export async function sweepOrphanBlobs(
  now = Date.now(),
  deps?: BlobStore,
): Promise<{ scanned: number; deleted: number }> {
  const blob: BlobStore = deps ?? (await vercelBlobStore());
  const client = await db();

  const rows = await client.execute(
    `SELECT audio_url FROM meetings WHERE audio_url IS NOT NULL`,
  );
  const referenced = new Set(rows.rows.map((row) => String(row.audio_url)));

  const orphans: string[] = [];
  let scanned = 0;
  let cursor: string | undefined;

  do {
    const page = await blob.list({ prefix: "audio/", cursor, limit: 1000 });
    for (const item of page.blobs) {
      scanned++;
      const age = now - new Date(item.uploadedAt).getTime();
      if (age > ORPHAN_MIN_AGE_MS && !referenced.has(item.url)) orphans.push(item.url);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && orphans.length < MAX_DELETES_PER_RUN);

  const toDelete = orphans.slice(0, MAX_DELETES_PER_RUN);
  if (toDelete.length > 0) {
    await blob.del(toDelete);
    logEvent("info", "sweep.orphan_blobs", { scanned, deleted: toDelete.length });
  }
  return { scanned, deleted: toDelete.length };
}
