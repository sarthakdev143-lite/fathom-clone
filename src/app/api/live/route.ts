import { NextResponse } from "next/server";
import { hasBlobToken, hasGroqKey, isDbConfigured } from "@/lib/config";
import { createLiveMeeting } from "@/lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts a live session. The row it creates is the meeting that will exist
 * afterwards, so nothing needs reconciling when the recording stops.
 */
export async function POST(request: Request) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured. TURSO_DATABASE_URL is not set." },
      { status: 503 },
    );
  }
  if (!hasGroqKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not set, so live captions are unavailable." },
      { status: 503 },
    );
  }
  if (!hasBlobToken) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN is not set, so the recording cannot be stored." },
      { status: 503 },
    );
  }

  let title = "Live meeting";
  try {
    const body = (await request.json()) as { title?: unknown };
    if (typeof body.title === "string" && body.title.trim() !== "") {
      title = body.title.trim().slice(0, 200);
    }
  } catch {
    // A missing title is fine; fall back to the default.
  }

  const id = await createLiveMeeting(title);
  return NextResponse.json({ id, status: "live" }, { status: 201 });
}
