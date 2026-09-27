import { NextResponse } from "next/server";
import {
  NotFoundError,
  getSegments,
  requireMeeting,
  saveSummary,
  setStatus,
} from "@/lib/meetings";
import { GroqError, chatCompletion } from "@/lib/groq";
import {
  SUMMARY_MODEL,
  SYSTEM_PROMPT,
  buildSummaryPrompt,
  parseSummary,
} from "@/lib/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;

  let title: string;
  let transcript: string;
  let segments: { start: number; end: number; text: string }[];

  try {
    const meeting = await requireMeeting(id);

    if (!meeting.transcript || meeting.transcript.trim() === "") {
      return NextResponse.json(
        { error: "This meeting has no transcript yet. Transcribe it first." },
        { status: 409 },
      );
    }

    title = meeting.title;
    transcript = meeting.transcript;
    segments = await getSegments(id);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }

  await setStatus(id, "summarizing");

  try {
    const completion = await chatCompletion({
      model: SUMMARY_MODEL,
      system: SYSTEM_PROMPT,
      user: buildSummaryPrompt({ title, transcript, segments }),
      temperature: 0.2,
      maxTokens: 2000,
      jsonMode: true,
    });

    const summary = parseSummary(completion.content);
    await saveSummary(id, summary);

    const meeting = await requireMeeting(id);

    return NextResponse.json({
      meeting,
      summary,
      usage: {
        model: completion.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      },
    });
  } catch (err) {
    const detail =
      err instanceof GroqError
        ? `${err.message}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : "Unknown summarization error.";

    await setStatus(id, "failed", detail);
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
