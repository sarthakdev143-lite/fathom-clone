import { GeminiError } from "./gemini";
import { GroqError } from "./groq";
import { runSummary } from "./providers";
import {
  getSegments,
  requireMeeting,
  saveSummary,
  setStatus,
} from "./meetings";
import {
  SUMMARY_MODEL,
  SYSTEM_PROMPT,
  buildSummaryPrompt,
  parseSummary,
  type MeetingSummary,
} from "./summary";

export interface SummarizeOutcome {
  summary: MeetingSummary;
  /** True when the transcript was sampled to fit the prompt budget. */
  sampled: boolean;
  segmentsUsed: number;
  segmentsTotal: number;
  provider: "groq" | "gemini";
  fallbackReason: string | null;
}

/**
 * The whole of step 3 in one function: read the transcript, make a single
 * prompt call, parse the JSON, store it. Shared by the HTTP route and the seed
 * script so both go through identical code.
 *
 * Throws on failure; the caller is responsible for recording the error on the
 * meeting, because only the caller knows the HTTP or CLI context.
 */
export async function summarizeMeeting(
  id: string,
): Promise<SummarizeOutcome> {
  const meeting = await requireMeeting(id);

  if (!meeting.transcript || meeting.transcript.trim() === "") {
    throw new Error("This meeting has no transcript yet. Transcribe it first.");
  }

  const segments = await getSegments(id);
  await setStatus(id, "summarizing");

  const { prompt, sampled, segmentsUsed, segmentsTotal } = buildSummaryPrompt({
    title: meeting.title,
    transcript: meeting.transcript,
    segments,
  });

  const completion = await runSummary({
    model: SUMMARY_MODEL,
    system: SYSTEM_PROMPT,
    user: prompt,
    temperature: 0.2,
    maxTokens: 2000,
    jsonMode: true,
  });

  const summary = parseSummary(completion.content);
  await saveSummary(id, summary, { sampled, segmentsUsed, segmentsTotal });

  return {
    summary,
    // Surfaced so a caller can tell a full read of the meeting from a sampled
    // one, which is a materially weaker summary.
    sampled,
    segmentsUsed,
    segmentsTotal,
    provider: completion.provider,
    fallbackReason: completion.fallbackReason,
  };
}

export { GeminiError, GroqError };
