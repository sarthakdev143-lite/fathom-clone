import { NextResponse } from "next/server";
import { hasBlobToken, hasGeminiKey, hasGroqKey, isDbConfigured } from "@/lib/config";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness and configuration probe for uptime monitors.
 *
 * 200 when the database answers; 503 otherwise. Provider keys are reported but
 * not called - a health check that spent model quota every minute would be its
 * own incident. Nothing secret is returned, only booleans.
 */
export async function GET() {
  const started = Date.now();
  let database: { ok: boolean; latencyMs?: number; error?: string };

  if (!isDbConfigured) {
    database = { ok: false, error: "not configured" };
  } else {
    try {
      const client = await db();
      await client.execute("SELECT 1");
      database = { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      database = { ok: false, error: err instanceof Error ? err.message : "unreachable" };
    }
  }

  const body = {
    ok: database.ok,
    database,
    providers: { groq: hasGroqKey, gemini: hasGeminiKey },
    blobStorage: hasBlobToken,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    time: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: database.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
