import { NextResponse } from "next/server";
import { hasGroqKey, isDbConfigured } from "@/lib/config";
import { transcribeAudio } from "@/lib/groq";
import { appendLiveSegments } from "@/lib/live";
import { refreshLiveSummaryIfDue } from "@/lib/live-summary";
import type { TranscriptSegment } from "@/lib/meetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** A chunk is a few seconds of 16 kHz mono PCM, so it is always well under 1 MB. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Accepts one short slice of audio, transcribes it, and appends the result to
 * the running transcript.
 *
 * Chunks are WAV files encoded from a raw PCM tap rather than slices of the
 * MediaRecorder stream. A WebM stream is not a valid media file until the
 * recording finishes - both a bare cluster and a header-prefixed cluster were
 * rejected by Whisper as `invalid_media_file` - so slicing it would produce
 * chunks that cannot be transcribed at all.
 */
export async function POST(request: Request, context: Context) {
  if (!isDbConfigured || !hasGroqKey) {
    return NextResponse.json(
      { error: "Live mode is not configured on this deployment." },
      { status: 503 },
    );
  }

  const { id } = await context.params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data." },
      { status: 400 },
    );
  }

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json(
      { error: "Missing a non-empty `audio` chunk." },
      { status: 400 },
    );
  }
  if (audio.size > MAX_CHUNK_BYTES) {
    return NextResponse.json(
      { error: `Chunk is ${audio.size} bytes, over the ${MAX_CHUNK_BYTES} byte limit.` },
      { status: 413 },
    );
  }

  // Where this slice starts in the overall recording, so live captions carry
  // timestamps that line up with the final transcript.
  const offset = Number(form.get("offset"));
  const startAt = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const audioTotal = Number(form.get("audioTotal"));
  const totalSeconds =
    Number.isFinite(audioTotal) && audioTotal > 0 ? audioTotal : startAt;

  let result;
  try {
    result = await transcribeAudio({
      audio: new Uint8Array(await audio.arrayBuffer()),
      filename: "chunk.wav",
      mimeType: "audio/wav",
    });
  } catch (err) {
    // A failed slice is recoverable: the client keeps sending, and the gap is
    // visible in the final transcript. Reporting it here would only make the
    // client retry a chunk that will keep failing.
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Chunk transcription failed.",
        recoverable: true,
      },
      { status: 502 },
    );
  }

  // Shift the chunk-local offsets into the meeting's timeline.
  const segments: TranscriptSegment[] = result.segments.map((segment) => ({
    start: round2(segment.start + startAt),
    end: round2(segment.end + startAt),
    text: segment.text,
  }));

  if (segments.length > 0) {
    await appendLiveSegments({
      id,
      segments,
      audioSeconds: totalSeconds,
      language: result.language,
    });
  }

  let summaryRefreshed = false;
  let summaryNote: string | undefined;
  if (segments.length > 0) {
    try {
      const outcome = await refreshLiveSummaryIfDue({
        id,
        audioSeconds: totalSeconds,
      });
      summaryRefreshed = outcome.refreshed;
      summaryNote = outcome.reason;
    } catch {
      // A provisional summary is a nicety; losing one must not lose captions.
      summaryNote = "summary refresh failed";
    }
  }

  return NextResponse.json({
    segments,
    totalSeconds,
    summaryRefreshed,
    ...(summaryNote ? { note: summaryNote } : {}),
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
