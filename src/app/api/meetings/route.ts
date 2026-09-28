import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { isTrustedBlobUrl } from "@/lib/blob-url";
import { createMeeting } from "@/lib/meetings";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
import type { MeetingSource } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates a meeting from audio that the browser has already uploaded to blob
 * storage.
 *
 * The audio bytes never pass through here. The client obtains a client token
 * from `/api/meetings/blob`, PUTs the file straight to Vercel Blob, and then
 * posts only the resulting URL plus metadata as JSON. That is what keeps long
 * recordings working on Vercel, where a function request body is capped at
 * 4.5 MB.
 */

interface CreateMeetingBody {
  title?: unknown;
  source?: unknown;
  duration?: unknown;
  audio?: {
    url?: unknown;
    filename?: unknown;
    mime?: unknown;
    size?: unknown;
  };
}

function asString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return base.length > 0 ? base.slice(0, 120) : "Untitled meeting";
}

export async function POST(request: Request) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured. TURSO_DATABASE_URL is not set." },
      { status: 503 },
    );
  }

  const limited = await rateLimit(request, RATE_RULES.createMeeting);
  if (limited) return limited;

  let body: CreateMeetingBody;
  try {
    body = (await request.json()) as CreateMeetingBody;
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON body." },
      { status: 400 },
    );
  }

  const audio = body.audio;

  if (!audio || typeof audio !== "object") {
    return NextResponse.json(
      { error: "Missing an `audio` object with a `url`." },
      { status: 400 },
    );
  }

  // The transcribe route fetches this URL from the server, so an unchecked
  // value would be a server-side request forgery vector.
  if (!isTrustedBlobUrl(audio.url)) {
    return NextResponse.json(
      {
        error:
          "audio.url must be an https URL on a Vercel Blob host. Upload the " +
          "file through /api/meetings/blob first.",
      },
      { status: 400 },
    );
  }

  const filename = asString(audio.filename, 200) ?? "audio.webm";
  const mime = asString(audio.mime, 120);
  const size = Number(audio.size);
  const audioBytes = Number.isFinite(size) && size > 0 ? Math.round(size) : null;

  if (audioBytes === null) {
    return NextResponse.json(
      { error: "audio.size must be a positive number of bytes." },
      { status: 400 },
    );
  }

  const rawSource = body.source;
  const source: MeetingSource =
    rawSource === "recording" || rawSource === "upload" ? rawSource : "upload";

  const title = asString(body.title, 200) ?? titleFromFilename(filename);

  const rawDuration = Number(body.duration);
  const durationSeconds =
    Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration * 100) / 100
      : null;

  const meeting = await createMeeting({
    title,
    source,
    audioFilename: filename,
    audioMime: mime,
    audioBytes,
    durationSeconds,
    audioUrl: audio.url,
  });

  return NextResponse.json({ meeting }, { status: 201 });
}
