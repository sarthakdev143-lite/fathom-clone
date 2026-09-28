import { NextResponse } from "next/server";
import { hasGroqKey, isDbConfigured } from "@/lib/config";
import { GeminiError, hasGeminiKey } from "@/lib/gemini";
import { GroqError } from "@/lib/groq";
import { errorFields, logEvent } from "@/lib/log";
import { getSegments, NotFoundError, requireMeeting } from "@/lib/meetings";
import { answerMeetingQuestion } from "@/lib/qa";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** One question is one prompt call; generous but bounded. */
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

/** Long enough for a real question, short enough to keep the prompt bounded. */
export const MAX_QUESTION_CHARS = 500;

export async function POST(request: Request, context: Context) {
  if (!isDbConfigured) {
    return NextResponse.json(
      { error: "Storage is not configured. TURSO_DATABASE_URL is not set." },
      { status: 503 },
    );
  }
  if (!hasGroqKey && !hasGeminiKey()) {
    return NextResponse.json(
      { error: "No provider is configured. Set GROQ_API_KEY, or GEMINI_API_KEY." },
      { status: 503 },
    );
  }

  const limited = await rateLimit(request, RATE_RULES.ask);
  if (limited) return limited;

  const { id } = await context.params;

  let body: { question?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `Keep the question under ${MAX_QUESTION_CHARS} characters.` },
      { status: 400 },
    );
  }

  let meeting;
  try {
    meeting = await requireMeeting(id);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }

  if (!meeting.transcript || meeting.transcript.trim() === "") {
    return NextResponse.json(
      { error: "This meeting has no transcript yet, so there is nothing to ask about." },
      { status: 409 },
    );
  }

  try {
    const outcome = await answerMeetingQuestion({
      title: meeting.title,
      summaryJson: meeting.summary_json,
      segments: await getSegments(id),
      transcript: meeting.transcript,
      question,
    });
    return NextResponse.json(outcome);
  } catch (err) {
    const detail =
      err instanceof GroqError || err instanceof GeminiError
        ? `${err.message}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : "Could not answer the question.";

    logEvent("error", "meeting_qa.failed", { meetingId: id, ...errorFields(err) });
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
