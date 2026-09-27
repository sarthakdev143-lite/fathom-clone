/**
 * Deployment configuration checks.
 *
 * Storage needs a hosted SQLite database when running on Vercel, because the
 * serverless filesystem is read-only and does not persist between invocations.
 * Locally the app falls back to a real SQLite file, so nothing here blocks
 * development; the checks exist so that a misconfigured deployment shows an
 * explanation instead of a stack trace.
 */

export const isVercel = Boolean(process.env.VERCEL);

/** True when a read can be expected to work in this environment. */
export const isDbConfigured = Boolean(process.env.TURSO_DATABASE_URL) || !isVercel;

export const hasGroqKey = Boolean(process.env.GROQ_API_KEY);

export const hasBlobToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/** Audio upload needs blob storage; without it the record page cannot work. */
export const isUploadConfigured = hasBlobToken;

export interface SetupIssue {
  envVar: string;
  problem: string;
  fix: string;
}

/** Everything that is missing right now, most important first. */
export function setupIssues(): SetupIssue[] {
  const issues: SetupIssue[] = [];

  if (!isDbConfigured) {
    issues.push({
      envVar: "TURSO_DATABASE_URL",
      problem:
        "No database is reachable. On Vercel a local SQLite file cannot be used, so TURSO_DATABASE_URL must point at a hosted libSQL/Turso database.",
      fix: "Create a free database at turso.tech, then set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the Vercel project environment.",
    });
  }

  if (!hasBlobToken) {
    issues.push({
      envVar: "BLOB_READ_WRITE_TOKEN",
      problem:
        "Audio upload is unavailable. The browser uploads recordings directly to Vercel Blob using a client token minted by the server, so a read-write token is required.",
      fix: "Create a Blob store (`vercel blob store add <name>`) and set BLOB_READ_WRITE_TOKEN in the Vercel project environment.",
    });
  }

  if (!hasGroqKey) {
    issues.push({
      envVar: "GROQ_API_KEY",
      problem:
        "Transcription and summarization are unavailable without a Groq API key.",
      fix: "Set GROQ_API_KEY in the Vercel project environment.",
    });
  }

  return issues;
}
