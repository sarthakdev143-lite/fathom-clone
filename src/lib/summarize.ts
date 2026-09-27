import { chatCompletion } from "./groq";
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

/**
 * The whole of step 3 in one function: read the transcript, make a single
 * prompt call, parse the JSON, store it. Shared by the HTTP route and the seed
 * script so both go through identical code.
 *
 * Throws on failure; the caller is responsible for recording the error on the
 * meeting, because only the caller knows the HTTP or CLI context.
 */
export async function summarizeMeeting(id: string): Promise<MeetingSummary> {
  const meeting = await requireMeeting(id);

  if (!meeting.transcript || meeting.transcript.trim() === "") {
    throw new Error("This meeting has no transcript yet. Transcribe it first.");
  }

  const segments = await getSegments(id);
  await setStatus(id, "summarizing");

  const completion = await chatCompletion({
    model: SUMMARY_MODEL,
    system: SYSTEM_PROMPT,
    user: buildSummaryPrompt({
      title: meeting.title,
      transcript: meeting.transcript,
      segments,
    }),
    temperature: 0.2,
    maxTokens: 2000,
    jsonMode: true,
  });

  const summary = parseSummary(completion.content);
  await saveSummary(id, summary);

  return summary;
}
