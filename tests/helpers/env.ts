/**
 * Imported first by every test file. `node --test` runs each file in its own
 * process, so each file gets its own throwaway SQLite database and a clean,
 * deterministic environment - never `.env.local`, never production.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "fathom-test-"));
export const TEST_DB_PATH = path.join(dir, "test.db");

process.env.TURSO_DATABASE_URL = `file:${TEST_DB_PATH.replace(/\\/g, "/")}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.VERCEL;
delete process.env.GEMINI_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.CRON_SECRET;
process.env.GROQ_API_KEY = "test-groq-key";
process.env.LOG_LEVEL = "silent";
