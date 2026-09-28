import { NextResponse } from "next/server";
import { createBudget } from "@/lib/budget";
import { hasGroqKey, isDbConfigured } from "@/lib/config";
import { GeminiError, hasGeminiKey } from "@/lib/gemini";
import { GroqError } from "@/lib/groq";
import { acquireLease } from "@/lib/lease";
import { errorFields, logEvent } from "@/lib/log";
import { NotFoundError, requireMeeting, setStatus } from "@/lib/meetings";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
import { summarizeMeetingStep } from "@/lib/summarize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Long transcripts are summarised window by window; see `src/lib/budget.ts`. */
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 *   200  done; the summary is stored and the meeting is `ready`
 *   202  some windows were summarised and saved; call again to continue
 *   409  no transcript yet, or another request holds the lease
 *   502  the summarizer failed in a way retrying will not fix
 */
export async function POST(request: Request, context: Context) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured. TURSO_DATABASE_URL is not set." },
      { status: 503 },
    );
  }

  // Either provider can serve this. Guarding on Groq alone would block a
  // Gemini-only deployment, which is exactly the configuration the fallback
  // exists to make work.
  if (!hasGroqKey && !hasGeminiKey()) {
    return NextResponse.json(
      {
        error:
          "No summarization provider is configured. Set GROQ_API_KEY, or " +
          "GEMINI_API_KEY to use the fallback.",
      },
      { status: 503 },
    );
  }

  const limited = await rateLimit(request, RATE_RULES.summarize);
  if (limited) return limited;

  const { id } = await context.params;
  const budget = createBudget();

  try {
    // Distinguishes a 404/409 from an upstream failure.
    const meeting = await requireMeeting(id);
    if (!meeting.transcript || meeting.transcript.trim() === "") {
      return NextResponse.json(
        { error: "This meeting has no transcript yet. Transcribe it first." },
        { status: 409 },
      );
    }
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
    const step = await summarizeMeetingStep(id, { budget, onUnit: lease.extend });

    if (!step.done) {
      logEvent("info", "summarize.partial", {
        meetingId: id,
        windowsDone: step.windowsDone,
        windowsTotal: step.windowsTotal,
        ms: Date.now() - started,
      });
      return NextResponse.json(
        {
          done: false,
          progress: { windowsDone: step.windowsDone, windowsTotal: step.windowsTotal },
          retryAfterSeconds: step.retryAfterSeconds ?? 0,
        },
        { status: 202 },
      );
    }

    logEvent("info", "summarize.done", {
      meetingId: id,
      windows: step.windows,
      provider: step.provider,
      ms: Date.now() - started,
    });

    return NextResponse.json({
      done: true,
      meeting: await requireMeeting(id),
      summary: step.summary,
      transcriptCoverage: {
        sampled: step.sampled,
        segmentsUsed: step.segmentsUsed,
        segmentsTotal: step.segmentsTotal,
        windows: step.windows,
      },
      provider: step.provider,
      fallbackReason: step.fallbackReason,
    });
  } catch (err) {
    const detail =
      err instanceof GroqError || err instanceof GeminiError
        ? `${err.message}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : "Unknown summarization error.";

    logEvent("error", "summarize.failed", { meetingId: id, ...errorFields(err) });
    await setStatus(id, "failed", detail);
    return NextResponse.json({ error: detail }, { status: 502 });
  } finally {
    await lease.release().catch(() => {});
  }
}
