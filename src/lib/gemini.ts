/**
 * Gemini fallback, used only when Groq fails.
 *
 * `gemini-3.5-transcribe` handles pre-recorded audio in a single unary request.
 * A second model, `gemini-3.5-transcribe-live`, exists for real-time streaming
 * but is reachable only over the Live API's stateful WebSocket, which a Vercel
 * function cannot hold open for the length of a meeting. Live captions therefore
 * use this same unary model, one call per audio slice - see
 * `current-status.md` for that trade-off.
 *
 * The response shape is the thing to get right: the transcript is NOT in
 * `part.text`. It arrives as `part.audioTranscription.text`, which is why a
 * naive implementation reports an empty transcription while having successfully
 * consumed the audio.
 */

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export const GEMINI_TRANSCRIBE_MODEL =
  process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-transcribe";
export const GEMINI_SUMMARY_MODEL =
  process.env.GEMINI_SUMMARY_MODEL || "gemini-3.5-flash";

/**
 * Conservative ceiling on audio sent inline. Gemini's documented request limit is
 * 20 MB and base64 inflates the payload by about a third, so ~14 MB of audio is
 * the safe inline figure. Verified working at 14.5 MB of base64. Beyond this the
 * Files API would be needed, and saying so plainly beats an opaque 400.
 */
export const GEMINI_MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;

export class GeminiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly quotaExhausted: boolean;

  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.detail = detail;
    this.quotaExhausted = status === 429;
  }
}

export function requireGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local and to the Vercel project " +
        "environment to enable the fallback provider.",
    );
  }
  return key;
}

export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function decodeError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // fall through
  }
  return body.slice(0, 500);
}

async function geminiFetch(
  model: string,
  payload: unknown,
  label: string,
  maxAttempts = 3,
  deadline = Number.POSITIVE_INFINITY,
): Promise<Record<string, unknown>> {
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(
        `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(
          requireGeminiKey(),
        )}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    } catch (err) {
      if (attempt === maxAttempts || Date.now() + 500 * 2 ** attempt > deadline) {
        throw new GeminiError(
          `${label} could not reach Gemini: ${
            err instanceof Error ? err.message : "network error"
          }`,
          0,
          "",
        );
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }

    const body = await response.text();
    if (response.ok) {
      return JSON.parse(body) as Record<string, unknown>;
    }

    lastStatus = response.status;
    lastBody = body;

    // 429 is Gemini's free-tier per-minute limit and does clear, so it is worth
    // waiting out. A 400 will not fix itself.
    if (response.status !== 429 || attempt === maxAttempts) break;
    const waitMs = Math.min(20_000, 2000 * 2 ** attempt);
    if (Date.now() + waitMs > deadline) break;
    await new Promise((r) => setTimeout(r, waitMs));
  }

  throw new GeminiError(
    `${label} failed (HTTP ${lastStatus})`,
    lastStatus,
    decodeError(lastBody),
  );
}

export interface GeminiTranscription {
  text: string;
  language: string | null;
  /** Always null: this model returns no timestamps. */
  segments: { start: number; end: number; text: string }[];
}

interface GeminiPart {
  text?: string;
  audioTranscription?: { text?: string };
}

/**
 * Pulls the parts array out of a generateContent response.
 *
 * Written with explicit narrowing rather than a cast chained into optional
 * chaining: `x as T | undefined` followed by `?.` is easy to get wrong, and
 * getting it wrong silently yields an empty transcript while the audio tokens
 * were consumed successfully.
 */
function responseParts(json: Record<string, unknown>): GeminiPart[] {
  const candidates = json.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const first = candidates[0];
  if (typeof first !== "object" || first === null) return [];

  const content = (first as { content?: unknown }).content;
  if (typeof content !== "object" || content === null) return [];

  const parts = (content as { parts?: unknown }).parts;
  return Array.isArray(parts) ? (parts as GeminiPart[]) : [];
}

/**
 * The transcript is NOT in `part.text` on this model - it arrives as
 * `part.audioTranscription.text`, and `text` is present but empty on the same
 * part. Reading only `text` reports a blank transcription for a call that
 * actually worked.
 */
function extractTranscript(parts: GeminiPart[]): string {
  const transcription = parts
    .map((part) => part.audioTranscription?.text ?? "")
    .join("")
    .trim();
  if (transcription) return transcription;

  return parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/**
 * Transcribes a complete audio file.
 *
 * `segments` is always empty because the model exposes no word-level timings on
 * a unary request. Callers that need offsets - the live chunk pipeline - place
 * the returned text at the slice's own offset, which is honest about the fact
 * that the internal timings are unknown.
 */
export async function transcribeWithGemini(input: {
  audio: Uint8Array;
  filename: string;
  mimeType: string | null;
  deadline?: number;
}): Promise<GeminiTranscription> {
  if (input.audio.byteLength === 0) {
    throw new Error("The stored audio is empty, so there is nothing to transcribe.");
  }
  if (input.audio.byteLength > GEMINI_MAX_INLINE_AUDIO_BYTES) {
    throw new GeminiError(
      `Audio is ${(input.audio.byteLength / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${GEMINI_MAX_INLINE_AUDIO_BYTES / 1024 / 1024} MB the Gemini inline fallback accepts. ` +
        "Uploading it to the Files API would be needed to cover this range.",
      413,
      "",
    );
  }

  const mimeType = input.mimeType || "application/octet-stream";
  const json = await geminiFetch(
    GEMINI_TRANSCRIBE_MODEL,
    {
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: mimeType,
                data: Buffer.from(input.audio).toString("base64"),
              },
            },
          ],
        },
      ],
    },
    "Gemini transcription",
    3,
    input.deadline,
  );

  const parts = responseParts(json);
  const text = extractTranscript(parts);

  if (!text) {
    throw new GeminiError(
      "Gemini returned no transcription text.",
      502,
      JSON.stringify(json).slice(0, 300),
    );
  }

  return { text, language: null, segments: [] };
}

/**
 * Summarization fallback, so a Groq outage does not take step 3 down with it.
 * Returns the raw model text; the shared parser validates the shape exactly as
 * it does for Groq, so there is only one definition of a valid summary.
 */
export async function summarizeWithGemini(input: {
  system: string;
  user: string;
  maxTokens?: number;
  deadline?: number;
}): Promise<string> {
  const json = await geminiFetch(
    GEMINI_SUMMARY_MODEL,
    {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.user }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: input.maxTokens ?? 2000,
        responseMimeType: "application/json",
      },
    },
    "Gemini summarization",
    3,
    input.deadline,
  );

  const parts = responseParts(json);
  const text = parts.map((part) => part.text ?? "").join("").trim();
  if (!text) {
    throw new GeminiError(
      "Gemini returned an empty completion.",
      502,
      JSON.stringify(json).slice(0, 300),
    );
  }
  return text;
}
