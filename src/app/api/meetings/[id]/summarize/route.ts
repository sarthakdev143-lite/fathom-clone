import { NextResponse } from "next/server";
import { hasGroqKey, isDbConfigured } from "@/lib/config";
import { NotFoundError, requireMeeting, setStatus } from "@/lib/meetings";
import { GroqError } from "@/lib/groq";
import { summarizeMeeting } from "@/lib/summarize";

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
      { error: "GROQ_API_KEY is not set, so summarization is unavailable." },
      { status: 503 },
    );
  }

  const { id } = await context.params;

  try {
    // Confirms the meeting exists and has a transcript, and distinguishes a
    // 404/409 from an upstream failure.
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

  try {
    const { summary, sampled, segmentsUsed, segmentsTotal } =
      await summarizeMeeting(id);

    return NextResponse.json({
      meeting: await requireMeeting(id),
      summary,
      transcriptCoverage: { sampled, segmentsUsed, segmentsTotal },
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
