/**
 * Step 3: summarization.
 *
 * The whole summary comes from a single prompt call that is required to return
 * one JSON object. There is no second pass, no per-field retry and no
 * post-hoc model call — whatever this returns is what gets stored.
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

export interface SummarizeInput {
  title: string;
  transcript: string;
  /** Timestamped segments, used to ground `key_moments`. */
  segments: { start: number; end: number; text: string }[];
}

/**
 * Builds the user half of the prompt. The transcript is annotated with the exact
 * offsets that `key_moments` must cite, so the model is choosing among real
 * timestamps rather than estimating them.
 */
export function buildSummaryPrompt(input: SummarizeInput): string {
  const lines = [
    `Meeting title: ${input.title}`,
    "",
    "Timestamped transcript. The [start-end] values are offsets in seconds:",
    "",
  ];

  for (const segment of input.segments) {
    lines.push(
      `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`,
    );
  }

  lines.push(
    "",
    "Full transcript:",
    "",
    input.transcript,
    "",
    "Return the JSON object now.",
  );

  return lines.join("\n");
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
