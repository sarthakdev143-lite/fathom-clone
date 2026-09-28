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
  /** Groq's machine-readable error code, e.g. `json_validate_failed`. */
  readonly code: string | null;
  /**
   * On a JSON-mode failure Groq returns what the model actually produced. It is
   * often usable JSON that merely failed strict validation, so it is kept.
   */
  readonly failedGeneration: string | null;

  constructor(
    message: string,
    status: number,
    detail: string,
    extra?: { code?: string | null; failedGeneration?: string | null },
  ) {
    super(message);
    this.name = "GroqError";
    this.status = status;
    this.detail = detail;
    this.code = extra?.code ?? null;
    this.failedGeneration = extra?.failedGeneration ?? null;
  }
}

/**
 * True for the 400 Groq returns when a `json_object` request produced output
 * it refused to hand back. Not a caller error: the same request usually
 * succeeds on a second try, or without JSON mode.
 */
export function isFailedGeneration(error: unknown): error is GroqError {
  return (
    error instanceof GroqError &&
    error.status === 400 &&
    (error.code === "json_validate_failed" ||
      error.failedGeneration !== null ||
      /failed_generation|failed to generate json/i.test(error.detail))
  );
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

export function decodeErrorBody(body: string): {
  message: string;
  code: string | null;
  failedGeneration: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") {
        return { message: error, code: null, failedGeneration: null };
      }
      if (error && typeof error === "object") {
        const nested = error as Record<string, unknown>;
        return {
          message: typeof nested.message === "string" ? nested.message : body.slice(0, 500),
          code: typeof nested.code === "string" ? nested.code : null,
          failedGeneration:
            typeof nested.failed_generation === "string" ? nested.failed_generation : null,
        };
      }
    }
  } catch {
    // fall through to the raw body
  }
  return { message: body.slice(0, 500), code: null, failedGeneration: null };
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
 *
 * `deadline` (epoch ms) stops the retry loop from sleeping past the calling
 * function's own lifetime. Without it a 60 s Retry-After, taken five times,
 * would outlive any serverless function and the work would be lost silently
 * instead of being reported and resumed.
 */
async function fetchGroq(
  url: string,
  buildInit: () => RequestInit,
  label: string,
  deadline = Number.POSITIVE_INFINITY,
): Promise<Response> {
  let lastStatus = 0;
  let lastBody = "";
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    // Built outside the try: a missing API key is a configuration error, not a
    // network blip, and must surface at once instead of after five backoffs.
    const init = buildInit();
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      // A connection-level failure is worth one more try.
      const waitMs = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 300;
      if (attempt === MAX_ATTEMPTS || Date.now() + waitMs > deadline) throw err;
      await sleep(waitMs);
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

    if (Date.now() + waitMs > deadline) break;
    await sleep(waitMs);
  }

  // Report the attempts actually made. Claiming the full retry budget on a 400,
  // which is never retried, sends whoever is debugging this looking in the
  // wrong place.
  const decoded = decodeErrorBody(lastBody);
  throw new GroqError(
    `${label} failed (HTTP ${lastStatus}) after ${attempts} attempt${
      attempts === 1 ? "" : "s"
    }`,
    lastStatus,
    decoded.message,
    { code: decoded.code, failedGeneration: decoded.failedGeneration },
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
  deadline?: number;
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
    input.deadline,
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
  deadline?: number;
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
    input.deadline,
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
