/**
 * A programmable stand-in for global fetch. Every provider client goes through
 * fetch, so routing on URL is enough to fake Groq, Gemini and blob storage
 * without touching any production code.
 */

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function installFetch(handler: FetchHandler) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export const GROQ_TRANSCRIBE = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";

export function groqChat(content: string) {
  return json({
    model: "test-model",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  });
}

export function groqTranscription(input: {
  text: string;
  segments?: { start: number; end: number; text: string }[];
  duration?: number;
}) {
  return json({
    text: input.text,
    language: "english",
    duration: input.duration ?? null,
    segments: input.segments ?? [{ start: 0, end: 5, text: input.text }],
  });
}

export const summaryJson = (tldr = "The team agreed on a plan.") =>
  JSON.stringify({
    tldr,
    topics: ["Planning"],
    decisions: ["Ship on Friday"],
    action_items: [{ task: "Draft the plan", owner: "Sam", due: "Friday" }],
    key_moments: [{ timestamp: 12.5, label: "Plan agreed" }],
  });
