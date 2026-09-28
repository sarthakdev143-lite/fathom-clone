/**
 * Step 3: summarization - prompts, windowing and parsing.
 *
 * A transcript that fits the prompt budget is summarised in one call. A longer
 * one is split into windows that are each summarised on their own ("map"),
 * then merged into one summary ("reduce"), so every sentence of the meeting is
 * read. The orchestration lives in `summarize.ts`; everything here is pure.
 */

/**
 * Overridable because Groq retires models without notice — `llama-3.3-70b-versatile`
 * was removed from the API between writing this and running it, so the id is
 * configuration rather than a hardcoded constant.
 */
export const SUMMARY_MODEL =
  process.env.SUMMARY_MODEL || "openai/gpt-oss-120b";

export interface ActionItem {
  task: string;
  owner: string | null;
  due: string | null;
}

export interface KeyMoment {
  /** Offset in seconds from the start of the recording, from a real segment. */
  timestamp: number;
  /** Short description of what happens at that point, at most eight words. */
  label: string;
}

export interface MeetingSummary {
  tldr: string;
  topics: string[];
  decisions: string[];
  action_items: ActionItem[];
  key_moments: KeyMoment[];
}

export const SYSTEM_PROMPT = `You summarise meeting transcripts. You always respond with a single JSON object and nothing else: no prose, no markdown fences, no commentary.

The object must have exactly these keys:

{
  "tldr": string,
  "topics": string[],
  "decisions": string[],
  "action_items": [{ "task": string, "owner": string | null, "due": string | null }],
  "key_moments": [{ "timestamp": number, "label": string }]
}

Rules:
- "tldr": two or three sentences maximum. Lead with the outcome, not the agenda.
- "topics": three to six short subject areas the meeting actually covered, each a noun phrase of at most five words. Do not invent topics that were not discussed.
- "decisions": only things that were actually concluded. If the meeting deferred something, that is not a decision, so leave it out. Each is a short sentence stating what was decided. Empty array if nothing was decided.
- "action_items": only commitments that were actually made. "task" is a short imperative phrase describing the work, not a bare noun ("Draft the migration plan", never "migration plan"). "owner" is the person's name as spoken, or null if nobody took it. "due" is a short natural phrase such as "Friday" or "end of week", or null if no deadline was stated. Never invent an owner or a deadline.
- "key_moments": three to six entries pointing at the most significant turns in the conversation. "timestamp" is the offset in SECONDS (a number like 74.5, never a string) taken from the timestamped transcript segments supplied to you. "label" is at most eight words describing what happens at that point.
- Every timestamp must be a real offset that appears in the supplied segments. Do not round to whole minutes arbitrarily and do not invent times that are not in the transcript.
- Return empty arrays rather than placeholder text when a category has no entries.
- Only use information present in the transcript. If a detail was never stated, leave it null.`;

/**
 * Groq's on-demand tier allows 8,000 tokens per minute, which also caps any
 * single request. A 32-minute transcript is roughly 35,000 characters, so a long
 * meeting cannot be sent in one piece and the request fails outright with a 413
 * rather than degrading.
 *
 * The budget is deliberately well under the ceiling to leave room for the system
 * prompt and the JSON response. When a transcript does not fit, segments are
 * sampled evenly across the whole meeting rather than truncated at the start, so
 * the model still sees the arc of the conversation and the timestamps it cites
 * stay real.
 */
export const MAX_TRANSCRIPT_CHARS = 24_000;

/**
 * Size of one map window. Smaller than the single-pass budget because a map
 * call runs back to back with others against the same per-minute token
 * allowance, and leaves room for the prompt and a 1,500-token reply.
 */
export const WINDOW_CHARS = 16_000;

/** Upper bound on the section summaries sent to one reduce call. */
export const REDUCE_INPUT_CHARS = 20_000;

export interface PromptBuild {
  prompt: string;
  /** True when segments were dropped to fit the token budget. */
  sampled: boolean;
  segmentsUsed: number;
  segmentsTotal: number;
}

export function renderSegments(
  segments: { start: number; end: number; text: string }[],
  sampled: boolean,
): string {
  const lines = segments.map(
    (segment) =>
      `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`,
  );
  if (lines.length === 0) return "(no transcript segments were available)";
  if (!sampled) return lines.join("\n");
  return (
    lines.join("\n") +
    "\n\n(some segments between these lines were omitted to fit the prompt's size " +
      "limit. Order and timestamps are unchanged.)"
  );
}

/**
 * Returns the segments to send, either all of them or an evenly spaced sample
 * that fits `budget` characters.
 */
function fitSegments(
  segments: { start: number; end: number; text: string }[],
  budget: number,
): { segments: typeof segments; sampled: boolean } {
  if (renderSegments(segments, false).length <= budget) {
    return { segments, sampled: false };
  }

  let current = segments;
  // Halving converges quickly and always keeps a chronological, evenly spaced
  // subset, so no single early passage dominates.
  while (current.length > 1 && renderSegments(current, true).length > budget) {
    current = current.filter((_, index) => index % 2 === 0);
  }

  return { segments: current, sampled: true };
}

export interface SummarizeInput {
  title: string;
  transcript: string;
  /** Timestamped segments, used to ground `key_moments`. */
  segments: { start: number; end: number; text: string }[];
}

/**
 * Builds the user half of the prompt.
 *
 * The timestamped segments are the single source of the transcript text: they
 * already contain every word, so appending the transcript again would double
 * the token cost of every call for no extra information.
 */
export function buildSummaryPrompt(input: SummarizeInput): PromptBuild {
  const { segments, sampled } = fitSegments(input.segments, MAX_TRANSCRIPT_CHARS);

  // A meeting with no usable segments still needs summarising, so fall back to
  // the plain transcript in that case.
  const body =
    input.segments.length > 0
      ? renderSegments(segments, sampled)
      : input.transcript;

  const prompt = [
    `Meeting title: ${input.title}`,
    "",
    "Timestamped transcript. The [start-end] values are offsets in seconds:",
    "",
    body,
    "",
    "Return the JSON object now.",
  ].join("\n");

  return {
    prompt,
    sampled,
    segmentsUsed: segments.length,
    segmentsTotal: input.segments.length,
  };
}

/** True when the whole transcript fits one summarization call. */
export function fitsSinglePass(input: SummarizeInput): boolean {
  if (input.segments.length > 0) {
    return renderSegments(input.segments, false).length <= MAX_TRANSCRIPT_CHARS;
  }
  return input.transcript.length <= MAX_TRANSCRIPT_CHARS;
}

export interface TranscriptWindow {
  /** Human-readable span, e.g. "00:00-15:02", or "part 2" without timings. */
  label: string;
  body: string;
  /** Offsets in seconds, or null when the transcript has no timings. */
  start: number | null;
  end: number | null;
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Splits a transcript into consecutive windows of at most `budget` characters.
 *
 * Deterministic for a given transcript, which is what makes map progress
 * resumable: a later request recomputes the same windows and skips the ones it
 * already has summaries for. Boundaries fall between segments (or between
 * sentences, for a transcript without timings), never inside one.
 */
export function buildWindows(
  input: SummarizeInput,
  budget = WINDOW_CHARS,
): TranscriptWindow[] {
  if (input.segments.length > 0) {
    const windows: TranscriptWindow[] = [];
    let current: typeof input.segments = [];
    let size = 0;

    const flush = () => {
      if (current.length === 0) return;
      const start = current[0].start;
      const end = current[current.length - 1].end;
      windows.push({
        label: `${formatClock(start)}-${formatClock(end)}`,
        body: renderSegments(current, false),
        start,
        end,
      });
      current = [];
      size = 0;
    };

    for (const segment of input.segments) {
      const line = `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}\n`;
      if (size + line.length > budget && current.length > 0) flush();
      current.push(segment);
      size += line.length;
    }
    flush();
    return windows;
  }

  // No timings: split on sentence ends, falling back to whitespace for a
  // run-on transcript with no punctuation at all.
  const sentences = input.transcript.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [
    input.transcript,
  ];
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= budget) {
      pieces.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += budget) pieces.push(sentence.slice(i, i + budget));
  }

  const windows: TranscriptWindow[] = [];
  let body = "";
  for (const piece of pieces) {
    if (body.length + piece.length > budget && body.trim()) {
      windows.push({ label: `part ${windows.length + 1}`, body: body.trim(), start: null, end: null });
      body = "";
    }
    body += piece;
  }
  if (body.trim()) {
    windows.push({ label: `part ${windows.length + 1}`, body: body.trim(), start: null, end: null });
  }
  return windows;
}

export function buildSectionPrompt(input: {
  title: string;
  window: TranscriptWindow;
  index: number;
  total: number;
}): string {
  const timed = input.window.start !== null;
  return [
    `Meeting title: ${input.title}`,
    "",
    `This is section ${input.index + 1} of ${input.total} of a longer meeting` +
      (timed ? `, covering ${input.window.label}.` : "."),
    "Summarise only what happens in this section. The \"tldr\" describes this " +
      "section in two or three sentences. Give one to three \"key_moments\" for " +
      "this section" +
      (timed ? ", using offsets that appear in the lines below." : "; with no timings available, return an empty array."),
    "",
    timed
      ? "Timestamped transcript. The [start-end] values are offsets in seconds from the start of the whole meeting:"
      : "Transcript:",
    "",
    input.window.body,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export const REDUCE_SYSTEM_PROMPT = `You merge the section-by-section summaries of ONE long meeting into a single summary of the whole meeting. You always respond with a single JSON object and nothing else: no prose, no markdown fences, no commentary.

The object must have exactly these keys:

{
  "tldr": string,
  "topics": string[],
  "decisions": string[],
  "action_items": [{ "task": string, "owner": string | null, "due": string | null }],
  "key_moments": [{ "timestamp": number, "label": string }]
}

Rules:
- "tldr": two or three sentences about the whole meeting. Lead with the outcome, not the agenda.
- "topics": three to six subject areas across the whole meeting, each a noun phrase of at most five words.
- "decisions": every decision from the sections, merged where two sections state the same one. If a later section reverses an earlier decision, keep only the final one. Do not add decisions the sections do not contain.
- "action_items": every distinct commitment from the sections. Sections overlap in what they repeat, so merge items that describe the same piece of work even when worded differently ("Add payload validation" and "Implement the payload validation fix" are one item), keeping the clearest wording. Keep "owner" and "due" exactly as given - if merged items disagree, keep the one stated later in the meeting. Never invent or infer them.
- "key_moments": three to six of the most significant moments of the whole meeting, chosen ONLY from the key moments listed in the sections. Copy each "timestamp" exactly as given. If no section has key moments, return an empty array.
- Only use information present in the section summaries.`;

/** Renders section summaries as the user half of a reduce call. */
export function buildReducePrompt(input: {
  title: string;
  sections: { label: string; summary: MeetingSummary }[];
}): string {
  return [
    `Meeting title: ${input.title}`,
    "",
    `Summaries of the meeting's ${input.sections.length} consecutive sections, in order:`,
    "",
    ...input.sections.map(
      (section, index) =>
        `## Section ${index + 1} (${section.label})\n${JSON.stringify(section.summary)}\n`,
    ),
    "Return the merged JSON object now.",
  ].join("\n");
}

/**
 * Moves each key moment onto the nearest real segment start and removes
 * duplicates. A merge step can round or misquote a timestamp; a moment that
 * does not land on a transcript line cannot be clicked through to, so it is
 * corrected rather than trusted.
 */
export function snapKeyMoments(
  moments: KeyMoment[],
  segments: { start: number }[],
  limit = 6,
): KeyMoment[] {
  if (segments.length === 0) return [];
  const starts = segments.map((s) => s.start).sort((a, b) => a - b);

  const nearest = (t: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const candidates = [starts[lo], starts[lo - 1]].filter(
      (v): v is number => typeof v === "number",
    );
    return candidates.reduce((best, v) => (Math.abs(v - t) < Math.abs(best - t) ? v : best));
  };

  const seen = new Set<number>();
  const out: KeyMoment[] = [];
  for (const moment of [...moments].sort((a, b) => a.timestamp - b.timestamp)) {
    const timestamp = nearest(moment.timestamp);
    if (seen.has(timestamp)) continue;
    seen.add(timestamp);
    out.push({ timestamp, label: moment.label });
  }
  return out.slice(0, limit);
}

/**
 * Parses the model's reply. Groq is asked for `json_object` mode, but a model
 * can still wrap JSON in prose or fences, so the object is located rather than
 * assumed, and the shape is checked field by field before it is trusted.
 */
export function parseSummary(raw: string): MeetingSummary {
  const text = raw.trim();

  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    candidate = extractJsonObject(text);
  }

  if (!isRecord(candidate)) {
    throw new Error(
      "The summarizer did not return a JSON object. Response began: " +
        text.slice(0, 200),
    );
  }

  const tldr = asString(candidate.tldr);
  if (!tldr) {
    throw new Error("The summarizer returned no `tldr`.");
  }

  return {
    tldr,
    topics: asStringArray(candidate.topics, 12),
    decisions: asStringArray(candidate.decisions, 20),
    action_items: asActionItems(candidate.action_items),
    key_moments: asKeyMoments(candidate.key_moments),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finds the first balanced {...} block, ignoring braces inside strings. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in the response.");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new Error("The JSON object in the response was never closed.");
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asString)
    .filter((entry): entry is string => entry !== null)
    .slice(0, limit);
}

function asActionItems(value: unknown): ActionItem[] {
  if (!Array.isArray(value)) return [];

  const items: ActionItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const task = asString(entry.task);
    if (!task) continue;
    items.push({
      task,
      owner: asString(entry.owner),
      due: asString(entry.due),
    });
  }
  return items;
}

function asKeyMoments(value: unknown): KeyMoment[] {
  if (!Array.isArray(value)) return [];

  const moments: KeyMoment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;

    // The prompt asks for a number, but a model may still send "1:14" or "74s".
    const seconds = toSeconds(entry.timestamp);
    if (seconds === null) continue;

    const label = asString(entry.label);
    if (!label) continue;

    moments.push({ timestamp: seconds, label });
  }

  return moments.sort((a, b) => a.timestamp - b.timestamp);
}

function toSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (clock) {
    const [, a, b, c] = clock;
    if (c !== undefined) {
      return Number(a) * 3600 + Number(b) * 60 + Number(c);
    }
    return Number(a) * 60 + Number(b);
  }

  const seconds = Number(trimmed.replace(/s$/i, ""));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
