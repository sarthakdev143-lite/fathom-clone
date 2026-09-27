import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createMeeting } from "@/lib/meetings";
import type { MeetingSource } from "@/lib/types";

export const runtime = "nodejs";
// Meeting writes must never be served from a cache.
export const dynamic = "force-dynamic";

/**
 * 25 MB of Opus audio is a little over an hour of speech, so this ceiling only
 * ever trips on a genuinely wrong file.
 *
 * Note for production: Vercel caps a serverless request body at 4.5 MB, which is
 * roughly 20 minutes of low-bitrate audio. Longer recordings need chunked upload,
 * which is out of scope for the capture step.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME_PREFIXES = ["audio/", "video/", "application/octet-stream"];

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

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a multipart/form-data body." },
      { status: 400 },
    );
  }

  const audio = form.get("audio");

  if (!(audio instanceof File)) {
    return NextResponse.json(
      { error: "Missing an `audio` file field." },
      { status: 400 },
    );
  }

  if (audio.size === 0) {
    return NextResponse.json(
      { error: "The uploaded audio file is empty." },
      { status: 400 },
    );
  }

  if (audio.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `Audio is ${(audio.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`,
      },
      { status: 413 },
    );
  }

  if (
    audio.type &&
    !ALLOWED_MIME_PREFIXES.some((prefix) => audio.type.startsWith(prefix))
  ) {
    return NextResponse.json(
      { error: `Unsupported audio type "${audio.type}".` },
      { status: 415 },
    );
  }

  const rawSource = form.get("source");
  const source: MeetingSource =
    rawSource === "recording" || rawSource === "upload" ? rawSource : "upload";

  const submittedTitle = form.get("title");
  const title =
    typeof submittedTitle === "string" && submittedTitle.trim().length > 0
      ? submittedTitle.trim().slice(0, 200)
      : titleFromFilename(audio.name || "meeting");

  const rawDuration = Number(form.get("duration"));
  const durationSeconds = Number.isFinite(rawDuration) && rawDuration > 0
    ? Math.round(rawDuration * 100) / 100
    : null;

  const meeting = await createMeeting({
    title,
    source,
    audioFilename: audio.name || null,
    audioMime: audio.type || null,
    audioBytes: audio.size,
    durationSeconds,
    audioBlob: new Uint8Array(await audio.arrayBuffer()),
  });

  return NextResponse.json({ meeting }, { status: 201 });
}
