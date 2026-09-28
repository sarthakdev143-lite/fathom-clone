import { NextResponse } from "next/server";
import { hasBlobToken, isDbConfigured } from "@/lib/config";
import { errorFields, logEvent } from "@/lib/log";
import { sweepOrphanBlobs, sweepStaleMeetings } from "@/lib/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily housekeeping, scheduled in `vercel.json`.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set on
 * the project, and it must be set: without it anyone could trigger blob
 * deletion. The meeting sweep alone is harmless and also runs on page loads.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not set, so the sweep endpoint is disabled." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured) {
    return NextResponse.json({ error: "Storage is not configured." }, { status: 503 });
  }

  const meetings = await sweepStaleMeetings();

  let blobs: { scanned: number; deleted: number } | { error: string } | null = null;
  if (hasBlobToken) {
    try {
      blobs = await sweepOrphanBlobs();
    } catch (err) {
      logEvent("error", "sweep.orphan_blobs_failed", errorFields(err));
      blobs = { error: err instanceof Error ? err.message : "failed" };
    }
  }

  return NextResponse.json({ meetings, blobs });
}
