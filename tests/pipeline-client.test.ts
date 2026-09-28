import "./helpers/env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeProgress, runStage, type StageProgress } from "@/lib/pipeline-client";
import { json } from "./helpers/fetch";

function scripted(responses: (() => Response)[]) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const next = responses[urls.length - 1];
    if (!next) throw new Error("unexpected extra request");
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("runStage", () => {
  it("keeps calling through 202s and returns the final payload", async () => {
    const { fetchImpl, urls } = scripted([
      () => json({ done: false, progress: { processedSeconds: 900 } }, 202),
      () => json({ done: false, progress: { processedSeconds: 1800 } }, 202),
      () => json({ done: true, transcript: { chunks: 3 } }),
    ]);
    const seen: StageProgress[] = [];
    const result = await runStage("m1", "transcribe", {
      fetchImpl,
      waitScale: 0,
      onProgress: (p) => seen.push(p),
    });
    assert.equal(result.transcript.chunks, 3);
    assert.equal(urls.length, 3);
    assert.equal(urls[0], "/api/meetings/m1/transcribe");
    assert.deepEqual(seen.map((p) => p.processedSeconds), [900, 1800]);
  });

  it("waits out a held lease and our own rate limit", async () => {
    const { fetchImpl, urls } = scripted([
      () => json({ inProgress: true, retryAfterSeconds: 5 }, 409),
      () => json({ error: "slow", retryAfterSeconds: 3 }, 429),
      () => json({ done: true }),
    ]);
    await runStage("m1", "summarize", { fetchImpl, waitScale: 0 });
    assert.equal(urls.length, 3);
  });

  it("survives a function killed by the platform (non-JSON 504)", async () => {
    const { fetchImpl } = scripted([
      () => new Response("<html>FUNCTION_INVOCATION_TIMEOUT</html>", { status: 504 }),
      () => json({ done: true, ok: 1 }),
    ]);
    const result = await runStage("m1", "transcribe", { fetchImpl, waitScale: 0 });
    assert.equal(result.ok, 1);
  });

  it("gives up after repeated platform failures", async () => {
    const dead = () => new Response("gateway", { status: 502 });
    const { fetchImpl } = scripted([dead, dead, dead, dead, dead]);
    await assert.rejects(runStage("m1", "transcribe", { fetchImpl, waitScale: 0 }), /HTTP 502/);
  });

  it("throws the server's message on a real error", async () => {
    const { fetchImpl } = scripted([() => json({ error: "No speech was detected in this audio." }, 422)]);
    await assert.rejects(runStage("m1", "transcribe", { fetchImpl, waitScale: 0 }), /No speech/);
  });

  it("does not treat our own JSON 502 as a platform failure", async () => {
    const { fetchImpl, urls } = scripted([() => json({ error: "Groq failed: invalid key" }, 502)]);
    await assert.rejects(runStage("m1", "summarize", { fetchImpl, waitScale: 0 }), /invalid key/);
    assert.equal(urls.length, 1);
  });
});

describe("describeProgress", () => {
  it("reads naturally for each stage", () => {
    assert.equal(describeProgress({ stage: "transcribe", processedSeconds: 1800 }), "Transcribed 30 min so far...");
    assert.equal(
      describeProgress({ stage: "summarize", windowsDone: 2, windowsTotal: 5 }),
      "Summarised 2 of 5 sections...",
    );
    assert.match(describeProgress({ stage: "summarize", waiting: true }) ?? "", /Waiting/);
    assert.equal(describeProgress(null), null);
  });
});
