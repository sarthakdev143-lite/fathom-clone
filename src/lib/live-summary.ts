import { chatCompletion, GroqError } from "./groq";
import { completeJson, type JsonCaller } from "./json-completion";
import {
  MAX_TRANSCRIPT_CHARS,
  SUMMARY_MODEL,
  buildSummaryPrompt,
  formatClock,
  renderSegments,
  type ActionItem,
} from "./summary";
import {
  isSummaryDue,
  readLiveSummaryState,
  readSegments,
  setLiveSummary,
  type LiveSummary,
} from "./live";
import type { TranscriptSegment } from "./meetings";

/**
 * The provisional summary shown while a meeting is still recording.
 *
 * Deliberately lighter than the real thing: no key moments, because timestamps
 * from partial audio are provisional in a way that would mislead, and the
 * authoritative version is produced by the normal step 3 pipeline once the
 * recording stops. This exists to give a sense of where the conversation is
 * going, not to be read as final.
 */

const LIVE_SYSTEM_PROMPT = `You summarise meeting transcripts that are still in progress. You always respond with a single JSON object and nothing else: no prose, no markdown fences.

The object must have exactly these keys:

{
  "tldr": string,
  "topics": string[],
  "decisions": string[],
  "action_items": [{ "task": string, "owner": string | null, "due": string | null }]
}

Rules:
- "tldr": one or two sentences describing what has been discussed and concluded so far. Write it as a progress update, not a conclusion.
- "topics": up to five short subject areas covered so far, each at most five words.
- "decisions": only things actually settled. Empty array if none yet.
- "action_items": only commitments actually made. "task" is a short imperative phrase, not a bare noun. "owner" is a name as spoken, or null. "due" is a short phrase as stated, or null. Never invent either.
- Return empty arrays rather than placeholder text.
- Only use what is in the transcript. Do not speculate about what may be discussed next.`;

export function parseLiveSummary(raw: string): LiveSummary {
  const text = raw.trim();

  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("Live summary was not JSON: " + text.slice(0, 120));
    }
    candidate = JSON.parse(text.slice(start, end + 1));
  }

  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Live summary was not a JSON object.");
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.tldr !== "string" || record.tldr.trim() === "") {
    throw new Error("Live summary had no `tldr`.");
  }

  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === "string" && v.trim() !== "")
          .map((v) => v.trim())
      : [];

  const actionItems: ActionItem[] = Array.isArray(record.action_items)
    ? record.action_items
        .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
        .filter((v) => typeof v.task === "string" && v.task.trim() !== "")
        .map((v) => ({
          task: (v.task as string).trim(),
          owner: typeof v.owner === "string" && v.owner.trim() ? v.owner.trim() : null,
          due: typeof v.due === "string" && v.due.trim() ? v.due.trim() : null,
        }))
    : [];

  return {
    tldr: record.tldr.trim(),
    topics: strings(record.topics).slice(0, 6),
    decisions: strings(record.decisions).slice(0, 8),
    action_items: actionItems,
  };
}

/**
 * Refreshes the provisional summary if enough new audio has arrived.
 *
 * Returns true when a new summary was written, so the caller can report it.
 * Throttling failures are swallowed: a dropped provisional summary is not worth
 * failing a chunk transcription over.
 */
export async function refreshLiveSummaryIfDue(input: {
  id: string;
  audioSeconds: number;
}): Promise<{ refreshed: boolean; reason?: string }> {
  if (!(await isSummaryDue(input.id, input.audioSeconds))) {
    return { refreshed: false };
  }

  const segments = await readSegments(input.id);
  if (segments.length === 0) {
    return { refreshed: false, reason: "no segments yet" };
  }

  const state = await readLiveSummaryState(input.id);
  const prompt = buildLivePrompt({
    segments,
    previous: state.previous,
    coveredSeconds: state.coveredSeconds,
  });

  const { value } = await completeJson(
    {
      system: LIVE_SYSTEM_PROMPT,
      user: prompt,
      maxTokens: 900,
      label: "live_summary",
    },
    parseLiveSummary,
    groqOnlyCaller,
  );

  await setLiveSummary(input.id, value, false, input.audioSeconds);

  return { refreshed: true };
}

/**
 * Live summaries stay on Groq only. Falling back to Gemini here would spend
 * the fallback's quota on a preview, and the chunk route relies on a Groq
 * 429 surfacing so the client can slow its cadence.
 */
const groqOnlyCaller: JsonCaller = async (input) => {
  const completion = await chatCompletion({
    model: SUMMARY_MODEL,
    system: input.system,
    user: input.user,
    temperature: 0.2,
    maxTokens: input.maxTokens,
    jsonMode: input.jsonMode,
  });
  return { content: completion.content, provider: "groq", fallbackReason: null };
};

/**
 * Builds the live prompt.
 *
 * While the transcript fits, the whole thing is sent, as before. Past that
 * point the summary becomes rolling: the previous provisional summary stands
 * in for everything it already covered, and only the newest segments are sent
 * verbatim. Nothing is sampled away, each call stays the same size however
 * long the meeting runs, and that is what makes lifting the old 20-minute
 * live ceiling affordable.
 */
export function buildLivePrompt(input: {
  segments: TranscriptSegment[];
  previous: LiveSummary | null;
  coveredSeconds: number;
}): string {
  const full = renderSegments(input.segments, false);
  if (full.length <= MAX_TRANSCRIPT_CHARS || !input.previous) {
    return buildSummaryPrompt({
      title: "In-progress meeting",
      transcript: input.segments.map((s) => s.text).join(" "),
      segments: input.segments,
    }).prompt;
  }

  // Newest first until the budget is used, then back into order. Starts a
  // little before the covered point so the model sees the seam in context.
  const budget = MAX_TRANSCRIPT_CHARS - 4_000;
  const recent: TranscriptSegment[] = [];
  let size = 0;
  for (let i = input.segments.length - 1; i >= 0; i--) {
    const segment = input.segments[i];
    const line = `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}\n`;
    if (size + line.length > budget) break;
    recent.unshift(segment);
    size += line.length;
    if (segment.end < input.coveredSeconds - 60) break;
  }

  const from = recent[0]?.start ?? input.coveredSeconds;

  return [
    "Meeting title: In-progress meeting",
    "",
    `Summary of the meeting up to about ${formatClock(input.coveredSeconds)}, written earlier:`,
    JSON.stringify(input.previous),
    "",
    `Transcript from ${formatClock(from)} onwards. The [start-end] values are offsets in seconds:`,
    "",
    renderSegments(recent, false),
    "",
    "Update the summary so it covers the whole meeting so far: keep what is still " +
      "true from the earlier summary, add what is new, and drop anything the newer " +
      "transcript reverses. Return the JSON object now.",
  ].join("\n");
}

export { GroqError };
