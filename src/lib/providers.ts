import {
  GroqError,
  chatCompletion,
  transcribeAudio as transcribeWithGroq,
  WHISPER_MODEL,
} from "./groq";
import {
  GeminiError,
  hasGeminiKey,
  summarizeWithGemini,
  transcribeWithGemini,
} from "./gemini";

/**
 * Provider selection.
 *
 * Groq stays the primary - it is faster, cheaper, and returns the segment
 * timings that `key_moments` depends on. Gemini is a fallback that exists so a
 * Groq outage degrades the product rather than breaking it.
 *
 * The failover is deliberately narrow. It triggers on the failures that are
 * actually the provider's fault: auth, rate limiting, server-side errors, and
 * network failure. A rejected upload or a missing transcript is the caller's
 * problem and must not be retried against a second provider, because that would
 * turn a user error into two billable calls.
 */

export type TranscriptionProvider = "groq" | "gemini";

export interface TranscriptionOutcome {
  text: string;
  language: string | null;
  duration: number | null;
  segments: { start: number; end: number; text: string }[];
  provider: TranscriptionProvider;
  /** Set when the primary failed and the fallback was used. */
  fallbackReason: string | null;
}

function groqIsWorthFallingBackOn(error: unknown): boolean {
  if (error instanceof GroqError) {
    return error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500;
  }
  // A plain Error here is a missing key or a local failure, not a provider
  // outage. Missing GROQ_API_KEY is handled separately below.
  return false;
}

function isMissingGroqKey(error: unknown): boolean {
  return (
    error instanceof Error && /GROQ_API_KEY is not set/.test(error.message)
  );
}

/**
 * Transcribes audio with Groq, falling back to Gemini.
 *
 * Segment timings are the one behavioural difference between the providers:
 * Gemini returns a single block of text with no internal timings, so when it
 * wins, `segments` is empty and the caller decides how to place the text on the
 * timeline. The authoritative transcript path treats an empty segment list as
 * "no timestamps available" and keeps the full text, which is correct.
 */
export async function transcribeAudio(input: {
  audio: Uint8Array;
  filename: string;
  mimeType: string | null;
}): Promise<TranscriptionOutcome> {
  try {
    const result = await transcribeWithGroq(input);
    return {
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
      provider: "groq",
      fallbackReason: null,
    };
  } catch (error) {
    const missingKey = isMissingGroqKey(error);
    const worthTrying = missingKey || groqIsWorthFallingBackOn(error);

    if (!worthTrying) throw error;

    if (!hasGeminiKey()) {
      // Nothing to fall back to. Report the original failure rather than a
      // vaguer "no fallback configured".
      throw error;
    }

    const reason = missingKey
      ? "GROQ_API_KEY is not set"
      : error instanceof Error
        ? error.message
        : "Groq failed";

    console.warn(`[transcribe] Groq failed, falling back to Gemini: ${reason}`);

    const result = await transcribeWithGemini(input);
    return {
      text: result.text,
      language: result.language,
      duration: null,
      segments: result.segments,
      provider: "gemini",
      fallbackReason: reason,
    };
  }
}

export type SummaryProvider = "groq" | "gemini";

export interface SummaryOutcome {
  content: string;
  provider: SummaryProvider;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  fallbackReason: string | null;
}

/**
 * Runs a summarization prompt, falling back to Gemini when Groq cannot answer.
 *
 * The fallback is worth having even though Groq is the better summariser: the
 * chat endpoint is the one that rate-limits hardest, and a summary failure
 * leaves a meeting with a transcript but no way to read it at a glance.
 */
export async function runSummary(input: {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<SummaryOutcome> {
  try {
    const completion = await chatCompletion({
      model: input.model,
      system: input.system,
      user: input.user,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      jsonMode: input.jsonMode,
    });
    return {
      content: completion.content,
      provider: "groq",
      model: completion.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      fallbackReason: null,
    };
  } catch (error) {
    const missingKey = isMissingGroqKey(error);
    const worthTrying = missingKey || groqIsWorthFallingBackOn(error);

    if (!worthTrying) throw error;
    if (!hasGeminiKey()) throw error;

    const reason = missingKey
      ? "GROQ_API_KEY is not set"
      : error instanceof Error
        ? error.message
        : "Groq failed";

    console.warn(`[summarize] Groq failed, falling back to Gemini: ${reason}`);

    const content = await summarizeWithGemini({
      system: input.system,
      user: input.user,
    });

    return {
      content,
      provider: "gemini",
      model: "gemini",
      inputTokens: null,
      outputTokens: null,
      fallbackReason: reason,
    };
  }
}

export { WHISPER_MODEL };
