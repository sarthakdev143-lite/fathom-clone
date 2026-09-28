import "./helpers/env";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  GroqError,
  chatCompletion,
  decodeErrorBody,
  isFailedGeneration,
  looksLikeSpeech,
  transcribeAudio,
} from "@/lib/groq";
import { GROQ_CHAT, groqChat, installFetch, json } from "./helpers/fetch";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("looksLikeSpeech", () => {
  it("rejects Whisper's non-speech hallucinations", () => {
    assert.equal(looksLikeSpeech(".", 30), false);
    assert.equal(looksLikeSpeech("...", null), false);
    assert.equal(looksLikeSpeech("Thank you.", 60), false);
  });

  it("accepts real speech", () => {
    assert.equal(looksLikeSpeech("Let's start the sprint planning now.", 4), true);
    assert.equal(looksLikeSpeech("a".repeat(120), 60), true);
  });
});

describe("decodeErrorBody", () => {
  it("extracts message, code and failed_generation", () => {
    const decoded = decodeErrorBody(
      JSON.stringify({
        error: {
          message: "Failed to generate JSON",
          code: "json_validate_failed",
          failed_generation: '{"tldr":"x"}',
        },
      }),
    );
    assert.deepEqual(decoded, {
      message: "Failed to generate JSON",
      code: "json_validate_failed",
      failedGeneration: '{"tldr":"x"}',
    });
  });

  it("falls back to the raw body", () => {
    assert.equal(decodeErrorBody("<html>bad gateway</html>").message, "<html>bad gateway</html>");
  });
});

describe("isFailedGeneration", () => {
  it("recognises Groq's JSON-mode 400", () => {
    assert.equal(
      isFailedGeneration(new GroqError("x", 400, "m", { code: "json_validate_failed" })),
      true,
    );
    assert.equal(isFailedGeneration(new GroqError("x", 400, "Failed to generate JSON.")), true);
  });

  it("does not treat an ordinary 400 or a 429 as one", () => {
    assert.equal(isFailedGeneration(new GroqError("x", 400, "invalid model")), false);
    assert.equal(isFailedGeneration(new GroqError("x", 429, "json_validate_failed")), false);
  });
});

describe("retry policy", () => {
  it("retries a 429 and then succeeds", async () => {
    let n = 0;
    const mock = installFetch(() =>
      ++n === 1 ? json({ error: { message: "slow down" } }, 429, { "retry-after": "0.01" }) : groqChat("ok"),
    );
    restore = mock.restore;

    const result = await chatCompletion({ model: "m", system: "s", user: "u" });
    assert.equal(result.content, "ok");
    assert.equal(mock.calls.length, 2);
  });

  it("does not retry a 400", async () => {
    const mock = installFetch(() => json({ error: { message: "bad request" } }, 400));
    restore = mock.restore;

    await assert.rejects(chatCompletion({ model: "m", system: "s", user: "u" }), (err: unknown) => {
      assert.ok(err instanceof GroqError);
      assert.equal(err.status, 400);
      assert.match(err.message, /after 1 attempt$/);
      return true;
    });
    assert.equal(mock.calls.length, 1);
  });

  it("carries failed_generation through on a JSON-mode 400", async () => {
    const mock = installFetch(() =>
      json(
        { error: { message: "Failed to generate JSON", code: "json_validate_failed", failed_generation: "{}" } },
        400,
      ),
    );
    restore = mock.restore;

    await assert.rejects(
      chatCompletion({ model: "m", system: "s", user: "u", jsonMode: true }),
      (err: unknown) => err instanceof GroqError && err.failedGeneration === "{}",
    );
  });

  it("stops retrying rather than sleep past the deadline", async () => {
    const mock = installFetch(() => json({ error: { message: "limited" } }, 429, { "retry-after": "30" }));
    restore = mock.restore;

    const started = Date.now();
    await assert.rejects(
      chatCompletion({ model: "m", system: "s", user: "u", deadline: Date.now() + 1000 }),
      (err: unknown) => err instanceof GroqError && err.status === 429,
    );
    assert.equal(mock.calls.length, 1);
    assert.ok(Date.now() - started < 2000);
  });

  it("refuses oversized and empty audio before calling the API", async () => {
    const mock = installFetch(() => json({}));
    restore = mock.restore;

    await assert.rejects(
      transcribeAudio({ audio: new Uint8Array(26 * 1024 * 1024), filename: "a.webm", mimeType: null }),
      /over Groq/,
    );
    await assert.rejects(
      transcribeAudio({ audio: new Uint8Array(0), filename: "a.webm", mimeType: null }),
      /empty/,
    );
    assert.equal(mock.calls.length, 0);
    assert.ok(GROQ_CHAT);
  });
});
