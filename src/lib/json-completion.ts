import { isFailedGeneration } from "./groq";
import { logEvent } from "./log";
import { runSummary } from "./providers";
import { SUMMARY_MODEL } from "./summary";

/**
 * A model call whose reply must parse into a specific JSON shape.
 *
 * Two failures used to send a meeting straight to `failed` even though a second
 * try almost always works:
 *
 *   1. Groq answers a `json_object` request with HTTP 400 `json_validate_failed`
 *      when the model's output did not validate. The body carries the output as
 *      `failed_generation`, which is frequently fine JSON with a trailing quirk,
 *      so the defensive parser gets a go at it first. If that does not work the
 *      call is repeated WITHOUT JSON mode and the parser locates the object.
 *   2. The reply is valid JSON of the wrong shape (no `tldr`, say). The call is
 *      repeated once with the parse error quoted back to the model.
 *
 * Rate limits and 5xx are not handled here - the transport already retries
 * them with backoff, and the provider layer falls back to Gemini.
 */

export interface JsonCallInput {
  system: string;
  user: string;
  maxTokens: number;
  jsonMode: boolean;
  deadline?: number;
}

export interface JsonCallResult {
  content: string;
  provider: "groq" | "gemini";
  fallbackReason: string | null;
}

export type JsonCaller = (input: JsonCallInput) => Promise<JsonCallResult>;

export const defaultJsonCaller: JsonCaller = async (input) => {
  const completion = await runSummary({
    model: SUMMARY_MODEL,
    system: input.system,
    user: input.user,
    temperature: 0.2,
    maxTokens: input.maxTokens,
    jsonMode: input.jsonMode,
    deadline: input.deadline,
  });
  return {
    content: completion.content,
    provider: completion.provider,
    fallbackReason: completion.fallbackReason,
  };
};

export const MAX_JSON_ATTEMPTS = 3;

export async function completeJson<T>(
  input: { system: string; user: string; maxTokens: number; deadline?: number; label: string },
  parse: (raw: string) => T,
  call: JsonCaller = defaultJsonCaller,
): Promise<{ value: T; provider: "groq" | "gemini"; fallbackReason: string | null; attempts: number }> {
  let jsonMode = true;
  let user = input.user;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
    let result: JsonCallResult;
    try {
      result = await call({
        system: input.system,
        user,
        maxTokens: input.maxTokens,
        jsonMode,
        deadline: input.deadline,
      });
    } catch (err) {
      if (!isFailedGeneration(err)) throw err;
      lastError = err;

      if (err.failedGeneration) {
        try {
          const value = parse(err.failedGeneration);
          logEvent("info", "json_completion.recovered_failed_generation", {
            label: input.label,
            attempt,
          });
          return { value, provider: "groq", fallbackReason: null, attempts: attempt };
        } catch {
          // Not salvageable; retry below.
        }
      }

      logEvent("warn", "json_completion.failed_generation", {
        label: input.label,
        attempt,
        nextJsonMode: false,
      });
      jsonMode = false;
      continue;
    }

    try {
      const value = parse(result.content);
      if (attempt > 1) {
        logEvent("info", "json_completion.recovered", { label: input.label, attempt });
      }
      return {
        value,
        provider: result.provider,
        fallbackReason: result.fallbackReason,
        attempts: attempt,
      };
    } catch (err) {
      lastError = err;
      const reason = err instanceof Error ? err.message : "unparseable reply";
      logEvent("warn", "json_completion.bad_shape", {
        label: input.label,
        attempt,
        reason: reason.slice(0, 200),
      });
      user =
        input.user +
        `\n\nYour previous reply could not be used: ${reason.slice(0, 200)}\n` +
        "Reply with only the JSON object described in the instructions, with every required key.";
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${input.label}: the model did not return usable JSON.`);
}
