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

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meetings (
     id                 TEXT PRIMARY KEY,
     title              TEXT NOT NULL,
     source             TEXT NOT NULL,
     audio_filename     TEXT,
     audio_mime         TEXT,
     audio_bytes        INTEGER,
     duration_seconds   REAL,
     status             TEXT NOT NULL DEFAULT 'uploaded',
     status_error       TEXT,
     transcript         TEXT,
     transcript_language TEXT,
     summary_json       TEXT,
     created_at         TEXT NOT NULL,
     updated_at         TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS meetings_created_at_idx ON meetings (created_at DESC)`,
];

export const isRemoteDb = Boolean(process.env.TURSO_DATABASE_URL);

let client: Client | null = null;
let ready: Promise<Client> | null = null;

async function connect(): Promise<Client> {
  const url = process.env.TURSO_DATABASE_URL || LOCAL_DB_PATH;

  if (!process.env.TURSO_DATABASE_URL) {
    const dir = path.dirname(path.resolve("data"));
    mkdirSync(dir, { recursive: true });
  }

  client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  await client.batch(SCHEMA.map((sql) => ({ sql, args: [] })), "write");

  return client;
}

export function db(): Promise<Client> {
  if (!ready) {
    ready = connect().catch((err) => {
      // Do not cache a failed connection; a later request should be able to retry.
      ready = null;
      client = null;
      throw err;
    });
  }
  return ready;
}
