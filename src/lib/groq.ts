/**
 * Groq client: Whisper for transcription, and a chat completion for
 * summarization. Both are OpenAI-compatible endpoints, so the wire format is a
 * multipart POST and a JSON POST respectively.
 */

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * `whisper-large-v3-turbo` is roughly 6x faster than `whisper-large-v3` at a
 * small accuracy cost. 25 MB is the free-tier upload cap, so oversized input
 * should be rejected before it reaches the API.
 */
export const WHISPER_MODEL = "whisper-large-v3-turbo";
export const GROQ_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class GroqError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = "GroqError";
    this.status = status;
    this.detail = detail;
  }
}

export function requireGroqKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it to .env.local (and to the Vercel project env for production).",
    );
  }
  return key;
}

interface RawSegment {
  start?: number;
  end?: number;
  text?: string;
}

function decodeErrorBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const message = record.error;
      if (typeof message === "string") return message;
      if (message && typeof message === "object") {
        const nested = (message as Record<string, unknown>).message;
        if (typeof nested === "string") return nested;
      }
    }
  } catch {
    // fall through to the raw body
  }
  return body.slice(0, 500);
}

const MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Groq rate-limits aggressively (HTTP 429) and occasionally returns 5xx, so both
 * are retried with exponential backoff and jitter. Anything else fails
 * immediately, because retrying a 400 just wastes the quota.
 *
 * `buildInit` is a factory rather than a value so each attempt gets a fresh
 * body: a consumed request body cannot be replayed.
 */
async function fetchGroq(
  url: string,
  buildInit: () => RequestInit,
  label: string,
): Promise<Response> {
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, buildInit());
    } catch (err) {
      // A connection-level failure is worth one more try.
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 300);
      continue;
    }

    if (response.ok) return response;

    lastStatus = response.status;
    lastBody = await response.text();

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) break;

    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(60_000, retryAfter * 1000)
        : Math.min(20_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;

    await sleep(waitMs);
  }

  throw new GroqError(
    `${label} failed (HTTP ${lastStatus}) after ${MAX_ATTEMPTS} attempts`,
    lastStatus,
    decodeErrorBody(lastBody),
  );
}

export interface GroqTranscription {
  text: string;
  language: string | null;
  duration: number | null;
  segments: { start: number; end: number; text: string }[];
}

/**
 * Whisper is known to hallucinate on non-speech audio: silence and pure tones
 * come back as ".", "Thank you." or a repeated phrase rather than an empty
 * string. Passing that on to the summarizer would let it invent a summary for
 * audio that contains no meeting at all, so it is screened here instead.
 *
 * Two checks, both deliberately conservative:
 *   - no letters or digits at all is definitively not speech;
 *   - sustained audio yielding under ~1 alphanumeric character per second is
 *     not a conversation either. Real speech sits far above that (measured
 *     output for the test clip was ~12 characters per second).
 */
export function looksLikeSpeech(
  text: string,
  durationSeconds: number | null,
): boolean {
  const alphanumeric = text.replace(/[^a-z0-9]/gi, "");
  if (alphanumeric.length === 0) return false;

  if (durationSeconds !== null && durationSeconds >= 5) {
    if (alphanumeric.length / durationSeconds < 1) return false;
  }

  return true;
}

/**
 * Sends the audio to Groq's Whisper endpoint.
 *
 * `verbose_json` with segment granularity is requested on purpose: step 3 has to
 * attach real timestamps to `key_moments`, which is only possible if the
 * transcription comes back with timings.
 */
export async function transcribeAudio(input: {
  audio: Uint8Array;
  filename: string;
  mimeType: string | null;
}): Promise<GroqTranscription> {
  if (input.audio.byteLength === 0) {
    throw new Error("The stored audio is empty, so there is nothing to transcribe.");
  }
  if (input.audio.byteLength > GROQ_MAX_UPLOAD_BYTES) {
    throw new Error(
      `Audio is ${(input.audio.byteLength / 1024 / 1024).toFixed(1)} MB, over Groq's ${GROQ_MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`,
    );
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([input.audio as BlobPart], { type: input.mimeType || "application/octet-stream" }),
    input.filename || "audio.webm",
  );
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetchGroq(
    `${GROQ_BASE_URL}/audio/transcriptions`,
    () => ({
      method: "POST",
      headers: { Authorization: `Bearer ${requireGroqKey()}` },
      body: form,
    }),
    "Groq transcription",
  );

  const body = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Groq returned a transcription that was not valid JSON.");
  }

  const record = parsed as Record<string, unknown>;
  const rawSegments = Array.isArray(record.segments)
    ? (record.segments as RawSegment[])
    : [];

  const segments = rawSegments
    .filter((segment) => typeof segment.text === "string" && segment.text.trim() !== "")
    .map((segment) => ({
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      text: (segment.text ?? "").trim(),
    }));

  return {
    text: typeof record.text === "string" ? record.text.trim() : "",
    language: typeof record.language === "string" ? record.language : null,
    duration: typeof record.duration === "number" ? record.duration : null,
    segments,
  };
}

export interface GroqChatResult {
  content: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export async function chatCompletion(input: {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<GroqChatResult> {
  const payload = JSON.stringify({
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    temperature: input.temperature ?? 0.2,
    max_tokens: input.maxTokens ?? 2000,
    response_format: input.jsonMode ? { type: "json_object" } : undefined,
  });

  const response = await fetchGroq(
    `${GROQ_BASE_URL}/chat/completions`,
    () => ({
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireGroqKey()}`,
        "Content-Type": "application/json",
      },
      body: payload,
    }),
    "Groq chat completion",
  );

  const body = await response.text();

  const parsed = JSON.parse(body) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Groq returned a chat completion with no content.");
  }

  return {
    content,
    model: parsed.model ?? input.model,
    inputTokens: parsed.usage?.prompt_tokens ?? null,
    outputTokens: parsed.usage?.completion_tokens ?? null,
  };
}
