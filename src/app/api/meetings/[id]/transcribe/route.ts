import { NextResponse } from "next/server";
import { createBudget } from "@/lib/budget";
import { hasGroqKey, isDbConfigured } from "@/lib/config";
import { GeminiError, hasGeminiKey } from "@/lib/gemini";
import { GroqError } from "@/lib/groq";
import { acquireLease } from "@/lib/lease";
import { errorFields, logEvent } from "@/lib/log";
import { NotFoundError, requireMeeting, setStatus } from "@/lib/meetings";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
import {
  AudioUnavailableError,
  NoSpeechError,
  transcribeMeetingStep,
} from "@/lib/transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Long audio is worked through in chunks; see `src/lib/budget.ts`. */
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 * Transcribes a meeting, or as much of it as fits in one request.
 *
 *   200  done; the transcript is stored and the meeting is `transcribed`
 *   202  progress was made and saved; call again to continue
 *   409  another request holds this meeting's lease, or there is no audio
 *   422  the audio contains no speech
 *   502  a provider failed in a way retrying will not fix
 */
export async function POST(request: Request, context: Context) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured. TURSO_DATABASE_URL is not set." },
      { status: 503 },
    );
  }

  // At least one provider must exist. Demanding Groq specifically would block a
  // Gemini-only deployment, which is a legitimate configuration for this
  // fallback to be useful in.
  if (!hasGroqKey && !hasGeminiKey()) {
    return NextResponse.json(
      {
        error:
          "No transcription provider is configured. Set GROQ_API_KEY, or " +
          "GEMINI_API_KEY to use the fallback.",
      },
      { status: 503 },
    );
  }

  const limited = await rateLimit(request, RATE_RULES.transcribe);
  if (limited) return limited;

  const { id } = await context.params;
  const budget = createBudget();

  try {
    await requireMeeting(id);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }

  const lease = await acquireLease(id);
  if (!lease) {
    return NextResponse.json(
      {
        error: "This meeting is already being processed.",
        inProgress: true,
        retryAfterSeconds: 5,
      },
      { status: 409 },
    );
  }

  const started = Date.now();
  try {
    await setStatus(id, "transcribing");
    const step = await transcribeMeetingStep(id, { budget, onUnit: lease.extend });

    if (!step.done) {
      logEvent("info", "transcribe.partial", {
        meetingId: id,
        processedSeconds: step.processedSeconds,
        chunks: step.chunks,
        ms: Date.now() - started,
      });
      return NextResponse.json(
        {
          done: false,
          progress: {
            processedSeconds: step.processedSeconds,
            chunks: step.chunks,
          },
          retryAfterSeconds: step.retryAfterSeconds ?? 0,
        },
        { status: 202 },
      );
    }

    logEvent("info", "transcribe.done", {
      meetingId: id,
      ...step.transcript,
      ms: Date.now() - started,
    });

    return NextResponse.json({
      done: true,
      meeting: await requireMeeting(id),
      transcript: step.transcript,
    });
  } catch (err) {
    if (err instanceof NoSpeechError) {
      // Whisper hallucinated filler for non-speech audio. Recording this as a
      // success would let step 3 summarise audio that contains no meeting.
      await setStatus(id, "failed", err.message);
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof AudioUnavailableError) {
      await setStatus(id, "failed", err.message);
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    const detail =
      err instanceof GroqError || err instanceof GeminiError
        ? `${err.message}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : "Unknown transcription error.";

    logEvent("error", "transcribe.failed", { meetingId: id, ...errorFields(err) });
    // Progress is deliberately kept, so a retry resumes rather than restarts.
    await setStatus(id, "failed", detail);
    return NextResponse.json({ error: detail }, { status: 502 });
  } finally {
    await lease.release().catch(() => {});
  }
}
