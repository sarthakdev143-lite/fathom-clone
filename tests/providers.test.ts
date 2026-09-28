import "./helpers/env";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GeminiError } from "@/lib/gemini";
import { GroqError } from "@/lib/groq";
import { isTransientProviderError, runSummary, transcribeAudio } from "@/lib/providers";
import { GROQ_TRANSCRIBE, groqChat, groqTranscription, installFetch, json } from "./helpers/fetch";

let restore: (() => void) | null = null;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
});
afterEach(() => {
  restore?.();
  restore = null;
  delete process.env.GEMINI_API_KEY;
});

const audio = { audio: new Uint8Array([1, 2, 3]), filename: "a.wav", mimeType: "audio/wav" };

const geminiTranscript = () =>
  json({
    candidates: [{ content: { parts: [{ text: "", audioTranscription: { text: "hello from gemini" } }] } }],
  });

describe("transcription fallback", () => {
  it("uses Groq when it works", async () => {
    const mock = installFetch(() => groqTranscription({ text: "hello from groq" }));
    restore = mock.restore;
    const result = await transcribeAudio(audio);
    assert.equal(result.provider, "groq");
    assert.equal(result.fallbackReason, null);
  });

  it("falls back to Gemini on a Groq 503 and records why", async () => {
    const mock = installFetch((url) =>
      url.startsWith(GROQ_TRANSCRIBE)
        ? json({ error: { message: "down" } }, 503, { "retry-after": "0.01" })
        : geminiTranscript(),
    );
    restore = mock.restore;
    const result = await transcribeAudio(audio);
    assert.equal(result.provider, "gemini");
    assert.equal(result.text, "hello from gemini");
    assert.match(result.fallbackReason ?? "", /HTTP 503/);
  });

  it("does not fall back on a 400 - a bad request is not the provider's fault", async () => {
    const mock = installFetch((url) =>
      url.startsWith(GROQ_TRANSCRIBE) ? json({ error: { message: "invalid file" } }, 400) : geminiTranscript(),
    );
    restore = mock.restore;
    await assert.rejects(transcribeAudio(audio), (err: unknown) => err instanceof GroqError);
    assert.equal(mock.calls.filter((c) => c.url.includes("generativelanguage")).length, 0);
  });

  it("falls back when the Groq key is missing", async () => {
    const saved = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const mock = installFetch(() => geminiTranscript());
    restore = () => {
      mock.restore();
      process.env.GROQ_API_KEY = saved;
    };
    const result = await transcribeAudio(audio);
    assert.equal(result.provider, "gemini");
    assert.equal(result.fallbackReason, "GROQ_API_KEY is not set");
  });
});

describe("summary fallback", () => {
  it("falls back to Gemini on a 429 that does not clear", async () => {
    const mock = installFetch((url) =>
      url.includes("groq.com")
        ? json({ error: { message: "limited" } }, 429, { "retry-after": "0.01" })
        : json({ candidates: [{ content: { parts: [{ text: '{"tldr":"g"}' }] } }] }),
    );
    restore = mock.restore;
    const result = await runSummary({ model: "m", system: "s", user: "u", jsonMode: true });
    assert.equal(result.provider, "gemini");
    assert.equal(result.content, '{"tldr":"g"}');
  });

  it("stays on Groq when it answers", async () => {
    const mock = installFetch(() => groqChat("{}"));
    restore = mock.restore;
    const result = await runSummary({ model: "m", system: "s", user: "u" });
    assert.equal(result.provider, "groq");
  });
});

describe("isTransientProviderError", () => {
  it("classifies rate limits, 5xx and network failures as transient", () => {
    assert.equal(isTransientProviderError(new GroqError("x", 429, "")), true);
    assert.equal(isTransientProviderError(new GroqError("x", 503, "")), true);
    assert.equal(isTransientProviderError(new GeminiError("x", 0, "")), true);
  });

  it("classifies client errors and plain errors as permanent", () => {
    assert.equal(isTransientProviderError(new GroqError("x", 400, "")), false);
    assert.equal(isTransientProviderError(new GeminiError("x", 413, "")), false);
    assert.equal(isTransientProviderError(new Error("x")), false);
  });
});
