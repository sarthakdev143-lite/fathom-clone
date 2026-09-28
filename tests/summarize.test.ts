import "./helpers/env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBudget } from "@/lib/budget";
import { db } from "@/lib/db";
import { GroqError } from "@/lib/groq";
import type { JsonCallInput, JsonCaller } from "@/lib/json-completion";
import { createMeeting, getMeeting, readProgress } from "@/lib/meetings";
import { summarizeMeetingStep } from "@/lib/summarize";
import { REDUCE_SYSTEM_PROMPT, buildWindows } from "@/lib/summary";

function segments(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 9,
    text: `In part ${i} the team discussed item ${i} in some detail. `.padEnd(200, "z"),
  }));
}

async function meetingWithTranscript(segs: ReturnType<typeof segments>) {
  const meeting = await createMeeting({ title: "Long planning", source: "upload" });
  const client = await db();
  await client.execute({
    sql: `UPDATE meetings SET transcript = ?, transcript_segments_json = ?, status = 'transcribed' WHERE id = ?`,
    args: [segs.map((s) => s.text).join(" "), JSON.stringify(segs), meeting.id],
  });
  return meeting.id;
}

/** Answers section calls with a per-section summary and reduce calls with a merge. */
function fakeModel(options: { failOn?: (call: JsonCallInput, n: number) => Error | null } = {}) {
  const calls: JsonCallInput[] = [];
  const caller: JsonCaller = async (call) => {
    calls.push(call);
    const failure = options.failOn?.(call, calls.length);
    if (failure) throw failure;

    if (call.system === REDUCE_SYSTEM_PROMPT) {
      const tldrs = [...call.user.matchAll(/"tldr":"([^"]+)"/g)].map((m) => m[1]);
      return {
        content: JSON.stringify({
          tldr: `Merged: ${tldrs.join(" | ")}`,
          topics: ["Planning"],
          decisions: ["Ship"],
          action_items: [{ task: "Follow up", owner: null, due: null }],
          // Deliberately off-grid, as a merge model might produce.
          key_moments: [{ timestamp: 101.7, label: "Turn" }],
        }),
        provider: "groq",
        fallbackReason: null,
      };
    }

    const section = /section (\d+) of/.exec(call.user)?.[1] ?? "single";
    return {
      content: JSON.stringify({
        tldr: `S${section}`,
        topics: [`T${section}`],
        decisions: [],
        action_items: [],
        key_moments: [{ timestamp: 10, label: `M${section}` }],
      }),
      provider: "groq",
      fallbackReason: null,
    };
  };
  return { caller, calls };
}

describe("summarizeMeetingStep", () => {
  it("summarises a short transcript in one call", async () => {
    const id = await meetingWithTranscript(segments(20));
    const { caller, calls } = fakeModel();
    const step = await summarizeMeetingStep(id, { call: caller });
    assert.equal(step.done, true);
    assert.equal(calls.length, 1);
    assert.equal((await getMeeting(id))?.status, "ready");
  });

  it("reads every window of a long transcript, then merges - nothing is sampled", async () => {
    const segs = segments(500); // ~100k characters
    const id = await meetingWithTranscript(segs);
    const windows = buildWindows({ title: "", transcript: "", segments: segs });
    const { caller, calls } = fakeModel();

    const step = await summarizeMeetingStep(id, { call: caller });
    assert.ok(step.done);
    assert.equal(step.windows, windows.length);
    assert.equal(step.sampled, false);
    assert.equal(calls.length, windows.length + 1);

    // Every section summary reached the merge.
    for (let i = 1; i <= windows.length; i++) assert.match(step.summary.tldr, new RegExp(`S${i}\\b`));
    // The off-grid key moment was snapped onto a real segment start.
    assert.deepEqual(step.summary.key_moments, [{ timestamp: 100, label: "Turn" }]);

    const row = await getMeeting(id);
    assert.equal(row?.status, "ready");
    assert.equal(row?.transcript_sampled, 0);
    assert.equal(await readProgress(id, "summary_progress_json"), null);
  });

  it("resumes from saved windows across requests", async () => {
    const segs = segments(500);
    const id = await meetingWithTranscript(segs);
    const total = buildWindows({ title: "", transcript: "", segments: segs }).length;

    const first = fakeModel();
    const step1 = await summarizeMeetingStep(id, { call: first.caller, budget: createBudget({ budgetMs: 0 }) });
    assert.equal(step1.done, false);
    assert.equal(first.calls.length, 1, "a zero budget still makes one unit of progress");
    if (!step1.done) assert.deepEqual([step1.windowsDone, step1.windowsTotal], [1, total]);

    const second = fakeModel();
    const step2 = await summarizeMeetingStep(id, { call: second.caller });
    assert.equal(step2.done, true);
    assert.equal(second.calls.length, total - 1 + 1, "done windows are not re-summarised");
    assert.doesNotMatch(second.calls[0].user, /section 1 of/);
  });

  it("pauses instead of failing when the provider is rate limited, keeping progress", async () => {
    const segs = segments(500);
    const id = await meetingWithTranscript(segs);
    const limited = fakeModel({
      failOn: (_call, n) => (n === 3 ? new GroqError("limited", 429, "") : null),
    });

    const step = await summarizeMeetingStep(id, { call: limited.caller });
    assert.equal(step.done, false);
    if (!step.done) {
      assert.equal(step.windowsDone, 2);
      assert.equal(step.retryAfterSeconds, 20);
    }
    assert.equal((await getMeeting(id))?.status, "summarizing");
  });

  it("recovers from Groq's failed_generation mid-map", async () => {
    const id = await meetingWithTranscript(segments(500));
    const flaky = fakeModel({
      failOn: (call, n) =>
        n === 2 && call.jsonMode
          ? new GroqError("x", 400, "Failed to generate JSON", { code: "json_validate_failed" })
          : null,
    });
    const step = await summarizeMeetingStep(id, { call: flaky.caller });
    assert.equal(step.done, true);
    assert.equal(flaky.calls[2].jsonMode, false);
  });

  it("propagates a permanent failure", async () => {
    const id = await meetingWithTranscript(segments(20));
    const broken = fakeModel({ failOn: () => new GroqError("bad", 401, "invalid key") });
    await assert.rejects(summarizeMeetingStep(id, { call: broken.caller }), /bad/);
  });
});
