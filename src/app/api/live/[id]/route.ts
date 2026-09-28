import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { getLiveDelta, touchLiveMeeting } from "@/lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * The polling endpoint. Server-Sent Events would be the natural transport for
 * one-directional updates, but a meeting can run for half an hour and a Vercel
 * function is terminated once it exceeds its duration limit, so a connection
 * held open for the duration of a recording cannot survive. Polling keeps every
 * request short and bounded.
 *
 * The client sends the number of segments it already has and the summary
 * version it last saw, and gets back only the difference. When nothing has
 * changed the response is a few bytes, so a 2-second interval is cheap even
 * across a 30-minute meeting.
 */
export async function GET(request: Request, context: Context) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured." },
      { status: 503 },
    );
  }

  const { id } = await context.params;
  const url = new URL(request.url);

  const sinceSegment = toCount(url.searchParams.get("segments"));
  const sinceSummary = toCount(url.searchParams.get("summary"));

  const delta = await getLiveDelta({ id, sinceSegment, sinceSummary });
  if (!delta) {
    return NextResponse.json({ error: "No live meeting with that id." }, { status: 404 });
  }

  // A heartbeat, so the stale-session sweep never closes a meeting whose tab
  // is still open (e.g. live captions failed to start, so no chunks arrive).
  if (delta.status === "live") {
    await touchLiveMeeting(id).catch(() => {});
  }

  return NextResponse.json(delta);
}

function toCount(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
