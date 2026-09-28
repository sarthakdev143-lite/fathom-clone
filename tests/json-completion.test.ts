import "./helpers/env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GroqError } from "@/lib/groq";
import { MAX_JSON_ATTEMPTS, completeJson, type JsonCallInput, type JsonCaller } from "@/lib/json-completion";
import { parseSummary } from "@/lib/summary";
import { summaryJson } from "./helpers/fetch";

const input = { system: "s", user: "u", maxTokens: 100, label: "test" };

function scripted(replies: ((call: JsonCallInput) => string | Error)[]) {
  const calls: JsonCallInput[] = [];
  const caller: JsonCaller = async (call) => {
    calls.push(call);
    const next = replies[calls.length - 1];
    if (!next) throw new Error("unexpected extra call");
    const reply = next(call);
    if (reply instanceof Error) throw reply;
    return { content: reply, provider: "groq", fallbackReason: null };
  };
  return { caller, calls };
}

const failedGeneration = (generation: string | null) =>
  new GroqError("Groq chat completion failed (HTTP 400)", 400, "Failed to generate JSON", {
    code: "json_validate_failed",
    failedGeneration: generation,
  });

describe("completeJson", () => {
  it("returns on the first good reply", async () => {
    const { caller, calls } = scripted([() => summaryJson()]);
    const result = await completeJson(input, parseSummary, caller);
    assert.equal(result.attempts, 1);
    assert.equal(calls[0].jsonMode, true);
  });

  it("salvages a usable failed_generation without another call", async () => {
    const { caller, calls } = scripted([() => failedGeneration("Here you go: " + summaryJson("salvaged"))]);
    const result = await completeJson(input, parseSummary, caller);
    assert.equal(result.value.tldr, "salvaged");
    assert.equal(calls.length, 1);
  });

  it("retries without JSON mode when failed_generation is unusable", async () => {
    const { caller, calls } = scripted([() => failedGeneration("garbage"), () => summaryJson("second")]);
    const result = await completeJson(input, parseSummary, caller);
    assert.equal(result.value.tldr, "second");
    assert.equal(calls[1].jsonMode, false);
  });

  it("retries a wrong-shape reply with the error quoted back", async () => {
    const { caller, calls } = scripted([() => '{"summary":"no tldr key"}', () => summaryJson("fixed")]);
    const result = await completeJson(input, parseSummary, caller);
    assert.equal(result.value.tldr, "fixed");
    assert.match(calls[1].user, /previous reply could not be used: .*tldr/);
  });

  it("gives up after the attempt limit with the last error", async () => {
    const { caller, calls } = scripted(Array(MAX_JSON_ATTEMPTS).fill(() => "not json"));
    await assert.rejects(completeJson(input, parseSummary, caller), /JSON/);
    assert.equal(calls.length, MAX_JSON_ATTEMPTS);
  });

  it("does not retry other provider errors - the transport already did", async () => {
    const { caller, calls } = scripted([() => new GroqError("limited", 429, "")]);
    await assert.rejects(completeJson(input, parseSummary, caller), (err: unknown) => err instanceof GroqError);
    assert.equal(calls.length, 1);
  });
});
