import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Storage is SQLite in both environments. The `@libsql/client` driver speaks the
 * SQLite wire protocol, so the only thing that changes between dev and Vercel is
 * the URL:
 *
 *   dev     file:./data/app.db          a real SQLite file on disk
 *   Vercel  libsql://<host>.turso.io   a hosted SQLite database
 *
 * A plain SQLite file cannot be used on Vercel because the serverless function
 * filesystem is read-only and does not persist between invocations.
 */

const LOCAL_DB_PATH = "file:./data/app.db";

/**
 * Forward-only migrations. Each entry moves the schema from version N to N+1 and
 * is applied exactly once, recorded in `_migrations`. The initial CREATE TABLE is
 * the version 0 shape and is deliberately never edited — later columns arrive via
 * ALTER so existing databases upgrade in place.
 */
const MIGRATIONS: string[][] = [
  // 0 -> 1: meetings
  [
    `CREATE TABLE IF NOT EXISTS meetings (
       id                  TEXT PRIMARY KEY,
       title               TEXT NOT NULL,
       source              TEXT NOT NULL,
       audio_filename      TEXT,
       audio_mime          TEXT,
       audio_bytes         INTEGER,
       duration_seconds    REAL,
       status              TEXT NOT NULL DEFAULT 'uploaded',
       status_error        TEXT,
       transcript          TEXT,
       transcript_language TEXT,
       summary_json        TEXT,
       created_at          TEXT NOT NULL,
       updated_at          TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS meetings_created_at_idx ON meetings (created_at DESC)`,
  ],
  // 1 -> 2: keep the audio bytes so transcription is a separate retryable step
  // instead of being welded onto the upload request.
  [`ALTER TABLE meetings ADD COLUMN audio_blob BLOB`],
  // 2 -> 3: word/segment timings, so summaries can cite real timestamps.
  [`ALTER TABLE meetings ADD COLUMN transcript_segments_json TEXT`],
  // 3 -> 4: audio is uploaded straight to blob storage by the browser, so the
  // meeting row keeps a URL instead of the bytes. `audio_blob` is left in place
  // so existing rows stay readable via the transcribe route's legacy path.
  [`ALTER TABLE meetings ADD COLUMN audio_url TEXT`],
  // 4 -> 5: records whether the summary was built from the whole transcript or
  // from an evenly sampled subset. Nullable, so rows summarised before this
  // existed read as unknown rather than falsely claiming full coverage.
  [`ALTER TABLE meetings ADD COLUMN transcript_sampled INTEGER`],
  // 5 -> 6: live mode. A meeting rows in as `live` and accumulates a partial
  // transcript in the existing columns; the seq counters let a poller fetch only
  // what changed since it last looked, instead of the whole transcript every
  // couple of seconds.
  [`ALTER TABLE meetings ADD COLUMN live_seq INTEGER NOT NULL DEFAULT 0`],
  [`ALTER TABLE meetings ADD COLUMN live_summary_seq INTEGER NOT NULL DEFAULT 0`],
  [`ALTER TABLE meetings ADD COLUMN live_audio_seconds REAL NOT NULL DEFAULT 0`],
  // Records the audio position at the last live summary refresh, so the refresh
  // throttle is derived from the database rather than from process memory. A
  // module-level counter would reset on every serverless cold start and refresh
  // far more often than intended.
  [`ALTER TABLE meetings ADD COLUMN live_summary_audio_seconds REAL NOT NULL DEFAULT 0`],
];

export const isRemoteDb = Boolean(process.env.TURSO_DATABASE_URL);

let ready: Promise<Client> | null = null;

async function connect(): Promise<Client> {
  const url = process.env.TURSO_DATABASE_URL || LOCAL_DB_PATH;

  if (!process.env.TURSO_DATABASE_URL) {
    mkdirSync(path.dirname(path.resolve("data")), { recursive: true });
  }

  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  // The bookkeeping table has to exist before it can be asked what it contains.
  await client.execute(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  const result = await client.execute(
    `SELECT COALESCE(MAX(version), 0) AS v FROM _migrations`,
  );
  const current = Number(result.rows[0]?.v ?? 0);

  for (let version = current; version < MIGRATIONS.length; version++) {
    const statements: { sql: string; args: (string | number)[] }[] =
      MIGRATIONS[version].map((sql) => ({ sql, args: [] }));
    statements.push({
      sql: `INSERT OR IGNORE INTO _migrations (version, applied_at) VALUES (?, ?)`,
      args: [version + 1, new Date().toISOString()],
    });
    await client.batch(statements, "write");
  }

  return client;
}

export function db(): Promise<Client> {
  if (!ready) {
    ready = connect().catch((err) => {
      // Do not cache a failed connection; a later request should be able to retry.
      ready = null;
      throw err;
    });
  }
  return ready;
}
