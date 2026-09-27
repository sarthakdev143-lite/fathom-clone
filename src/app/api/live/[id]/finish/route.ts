import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { isTrustedBlobUrl } from "@/lib/blob-url";
import { finishLiveMeeting } from "@/lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * Closes the live phase once the full recording has been uploaded to blob
 * storage, and moves the meeting to `uploaded`.
 *
 * From there the ordinary pipeline takes over unchanged: the client calls
 * `/api/meetings/[id]/transcribe` and then `/api/meetings/[id]/summarize`. The
 * live transcript is a preview and is overwritten by the authoritative one,
 * because re-transcribing the complete audio removes the seam artefacts that
 * slicing a recording into chunks introduces.
 */
export async function POST(request: Request, context: Context) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured." },
      { status: 503 },
    );
  }

  const { id } = await context.params;

  let body: {
    audioUrl?: unknown;
    filename?: unknown;
    mime?: unknown;
    size?: unknown;
    duration?: unknown;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  // The transcribe route fetches this URL, so it is validated rather than
  // trusted: an unchecked URL would be a server-side request forgery vector.
  if (!isTrustedBlobUrl(body.audioUrl)) {
    return NextResponse.json(
      { error: "audioUrl must be an https URL on a Vercel Blob host." },
      { status: 400 },
    );
  }

  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) {
    return NextResponse.json(
      { error: "size must be a positive number of bytes." },
      { status: 400 },
    );
  }

  const duration = Number(body.duration);
  const durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : null;

  try {
    await finishLiveMeeting({
      id,
      audioUrl: body.audioUrl,
      filename: typeof body.filename === "string" ? body.filename.slice(0, 200) : "audio.webm",
      mime: typeof body.mime === "string" ? body.mime.slice(0, 120) : "audio/webm",
      size: Math.round(size),
      durationSeconds,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not finalise." },
      { status: 404 },
    );
  }

  return NextResponse.json({ id, status: "uploaded" });
}
