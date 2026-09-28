import {
  completeJson,
  defaultJsonCaller,
  type JsonCaller,
} from "./json-completion";
import { logEvent } from "./log";
import type { TranscriptSegment } from "./meetings";
import { renderSegments, snapKeyMoments } from "./summary";

/**
 * "Ask about this meeting", without embeddings.
 *
 * A full transcript plus a question fits one prompt call for ordinary
 * meetings, but a two-hour transcript does not fit any single request on the
 * free tier. Instead the transcript is ranked against the question by plain
 * token overlap and the best-matching segments go in, oldest first, up to a
 * budget - retrieval with no index to build, no vectors to store, and nothing
 * to keep in sync when a transcript is re-done. The meeting summary always
 * goes in too, so a question about the overall outcome is answered even when
 * none of its words appear in the retrieved lines.
 */

const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,when,what,whats,when,who,whom,whose,which,how,why,do,does,did,is,are,was,were,be,been,being,have,has,had,having,will,would,should,could,can,may,might,must,shall,of,in,on,at,to,for,with,about,into,over,after,before,between,through,up,out,as,by,from,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,their,my,your,me,him,us,not,no,yes,so,such,than,too,very,just,any,each,other,some,all,only,own,same,also,there,here".split(
    ",",
  ),
);

export function questionTokens(question: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of question.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length > 2 && !STOPWORDS.has(word)) tokens.add(word);
  }
  return tokens;
}

function segmentScore(segment: TranscriptSegment, query: Set<string>): number {
  if (query.size === 0) return 0;
  const words = new Set(segment.text.toLowerCase().split(/[^a-z0-9]+/));
  let score = 0;
  for (const token of query) if (words.has(token)) score++;
  return score;
}

export interface RetrievedContext {
  body: string;
  segmentsUsed: number;
  segmentsTotal: number;
  truncated: boolean;
}

/** Question-relevant transcript lines, chronologically, within `budget` chars. */
export function retrieveContext(
  segments: TranscriptSegment[],
  question: string,
  budget = 12_000,
): RetrievedContext {
  if (segments.length === 0) {
    return { body: "(no timestamped transcript available)", segmentsUsed: 0, segmentsTotal: 0, truncated: false };
  }

  const query = questionTokens(question);
  const ranked = segments
    .map((segment, index) => ({ segment, index, score: segmentScore(segment, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // No word in common: the question is about the meeting as a whole, so the
  // opening sets the scene better than arbitrary middle lines.
  const interesting = ranked.some((r) => r.score > 0) ? ranked.filter((r) => r.score > 0) : ranked;

  const chosen: TranscriptSegment[] = [];
  let size = 0;
  for (const { segment } of interesting) {
    const line = `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}\n`;
    if (size + line.length > budget && chosen.length > 0) break;
    chosen.push(segment);
    size += line.length;
  }
  chosen.sort((a, b) => a.start - b.start);

  return {
    body: renderSegments(chosen, false),
    segmentsUsed: chosen.length,
    segmentsTotal: segments.length,
    truncated: chosen.length < segments.length,
  };
}

export const QA_SYSTEM_PROMPT = `You answer questions about one meeting. You always respond with a single JSON object and nothing else: no prose, no markdown fences, no commentary.

The object must have exactly these keys:

{
  "answer": string,
  "citations": [{ "timestamp": number, "quote": string }]
}

Rules:
- Answer ONLY from the meeting summary and transcript lines given to you. If they do not cover the question, say so plainly in one sentence and return an empty citations array. Never use outside knowledge and never invent details.
- Keep the answer short: two to four sentences, then stop. Quote names, owners and dates exactly as spoken.
- "citations": up to three entries supporting the answer. "timestamp" is an offset in SECONDS copied exactly from a transcript line supplied to you. "quote" is a few words from that line. If no line supports the answer, return [].`;

export interface MeetingCitation {
  timestamp: number;
  quote: string;
}

export interface MeetingAnswer {
  answer: string;
  citations: MeetingCitation[];
}

function parseAnswer(raw: string): MeetingAnswer {
  const text = raw.trim();
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new Error("The answer was not JSON.");
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("The answer was not a JSON object.");
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.answer !== "string" || record.answer.trim() === "") {
    throw new Error("The answer had no `answer` text.");
  }
  const citations: MeetingCitation[] = [];
  if (Array.isArray(record.citations)) {
    for (const entry of record.citations) {
      if (typeof entry !== "object" || entry === null) continue;
      const { timestamp, quote } = entry as Record<string, unknown>;
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) continue;
      if (typeof quote !== "string" || quote.trim() === "") continue;
      citations.push({ timestamp, quote: quote.trim() });
    }
  }
  return { answer: record.answer.trim(), citations: citations.slice(0, 3) };
}

export interface AskInput {
  title: string;
  summaryJson: string | null;
  segments: TranscriptSegment[];
  transcript: string | null;
  question: string;
  maxTokens?: number;
  deadline?: number;
  call?: JsonCaller;
}

export interface AskOutcome extends MeetingAnswer {
  provider: "groq" | "gemini";
  fallbackReason: string | null;
  context: RetrievedContext;
}

/**
 * Answers one question. Read-only: nothing is written to the meeting, so no
 * lease is needed and asking twice costs twice but corrupts nothing.
 */
export async function answerMeetingQuestion(input: AskInput): Promise<AskOutcome> {
  const call = input.call ?? defaultJsonCaller;
  const context =
    input.segments.length > 0
      ? retrieveContext(input.segments, input.question)
      : {
          body: input.transcript?.trim() || "(no transcript available)",
          segmentsUsed: 0,
          segmentsTotal: 0,
          truncated: false,
        };

  const user = [
    `Meeting title: ${input.title}`,
    "",
    input.summaryJson ? `Meeting summary:\n${input.summaryJson}\n` : "",
    "Relevant transcript lines. The [start-end] values are offsets in seconds:",
    "",
    context.body,
    "",
    `Question: ${input.question}`,
    "",
    "Return the JSON object now.",
  ].join("\n");

  const started = Date.now();
  const result = await completeJson(
    {
      system: QA_SYSTEM_PROMPT,
      user,
      maxTokens: input.maxTokens ?? 800,
      deadline: input.deadline,
      label: "meeting_qa",
    },
    parseAnswer,
    call,
  );

  // A merged answer can round a timestamp; move each citation onto the
  // nearest real segment start so it stays clickable.
  const citations =
    input.segments.length > 0
      ? snapKeyMoments(
          result.value.citations.map((c) => ({ timestamp: c.timestamp, label: c.quote })),
          input.segments,
          3,
        ).map((m) => ({ timestamp: m.timestamp, quote: m.label }))
      : [];

  logEvent("info", "meeting_qa.answered", {
    provider: result.provider,
    citations: citations.length,
    ms: Date.now() - started,
  });

  return {
    answer: result.value.answer,
    citations,
    provider: result.provider,
    fallbackReason: result.fallbackReason,
    context,
  };
}
