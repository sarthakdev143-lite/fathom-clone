import { NextResponse } from "next/server";
import { hasGroqKey, isDbConfigured } from "@/lib/config";
import {
  NotFoundError,
  loadAudio,
  requireMeeting,
  saveTranscript,
  setStatus,
  type AudioSource,
} from "@/lib/meetings";
import { GroqError, looksLikeSpeech, transcribeAudio } from "@/lib/groq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured. TURSO_DATABASE_URL is not set." },
      { status: 503 },
    );
  }

  if (!hasGroqKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY is not set, so transcription is unavailable." },
      { status: 503 },
    );
  }

  const { id } = await context.params;

  let audio: AudioSource;

  try {
    const meeting = await requireMeeting(id);
    const loaded = await loadAudio(meeting);

    if (!loaded) {
      return NextResponse.json(
        { error: "This meeting has no stored audio to transcribe." },
        { status: 409 },
      );
    }
    audio = loaded;
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    // loadAudio throws a plain Error for unreachable or untrusted audio.
    const detail = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: detail }, { status: 409 });
  }

  await setStatus(id, "transcribing");

  try {
    const result = await transcribeAudio({
      audio: audio.bytes,
      filename: audio.filename,
      mimeType: audio.mimeType,
    });

    if (!looksLikeSpeech(result.text, result.duration)) {
      // Whisper hallucinated filler for non-speech audio. Recording this as a
      // success would let step 3 summarise audio that contains no meeting.
      await setStatus(
        id,
        "failed",
        "No speech was detected in this audio.",
      );
      return NextResponse.json(
        { error: "No speech was detected in this audio." },
        { status: 422 },
      );
    }

    await saveTranscript(id, {
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
    });

    const meeting = await requireMeeting(id);
    return NextResponse.json({
      meeting,
      transcript: {
        characters: result.text.length,
        segments: result.segments.length,
        language: result.language,
        duration: result.duration,
      },
    });
  } catch (err) {
    const detail =
      err instanceof GroqError
        ? `${err.message}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : "Unknown transcription error.";

    await setStatus(id, "failed", detail);
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
