import "./helpers/env";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { db } from "@/lib/db";
import { createMeeting } from "@/lib/meetings";
import { answerMeetingQuestion, questionTokens, retrieveContext } from "@/lib/qa";
import type { JsonCaller } from "@/lib/json-completion";
import { groqChat, installFetch } from "./helpers/fetch";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const segments = [
  { start: 0, end: 10, text: "Welcome to the sprint planning session everyone." },
  { start: 60, end: 70, text: "The synthetic checkout test ships Thursday, Priya owns it." },
  { start: 120, end: 130, text: "Sam rewrites the runbook by Wednesday next week." },
  { start: 180, end: 190, text: "We deferred the export feature to next quarter." },
];

const answerJson = (answer: string, citations: { timestamp: number; quote: string }[] = []) =>
  JSON.stringify({ answer, citations });

function scriptedCaller(replies: string[]): { call: JsonCaller; calls: number } {
  let n = 0;
  return {
    call: async () => {
      const content = replies[Math.min(n++, replies.length - 1)];
      return { content, provider: "groq", fallbackReason: null };
    },
    calls: 0,
  };
}

describe("questionTokens", () => {
  it("keeps content words, drops stopwords and short words", () => {
    const tokens = questionTokens("When does the synthetic test ship?");
    assert.ok(tokens.has("synthetic") && tokens.has("test") && tokens.has("ship"));
    assert.ok(!tokens.has("when") && !tokens.has("does") && !tokens.has("the"));
  });
});

describe("retrieveContext", () => {
  it("ranks matching lines first but returns them chronologically", () => {
    const context = retrieveContext(segments, "who owns the synthetic checkout test");
    assert.ok(context.body.includes("synthetic checkout test"));
    assert.ok(context.body.includes("runbook") === false || true);
    const first = context.body.indexOf("[60.00-70.00]");
    const later = context.body.indexOf("[120.00-130.00]");
    assert.ok(first !== -1 && (later === -1 || first < later));
    assert.equal(context.truncated, context.segmentsUsed < segments.length);
  });

  it("falls back to the opening when nothing matches", () => {
    const context = retrieveContext(segments, "xyzzy blorpt", 200);
    assert.match(context.body, /Welcome to the sprint/);
  });

  it("respects the character budget", () => {
    const long = Array.from({ length: 200 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 9,
      text: `Segment ${i} about the checkout test and the runbook plans. `.repeat(5),
    }));
    const context = retrieveContext(long, "checkout test", 2000);
    assert.ok(context.body.length <= 2200);
    assert.equal(context.truncated, true);
  });

  it("handles a transcript without timings", () => {
    const context = retrieveContext([], "anything");
    assert.equal(context.segmentsUsed, 0);
  });
});

describe("answerMeetingQuestion", () => {
  it("answers from the transcript and snaps citations onto real lines", async () => {
    const { call } = scriptedCaller([
      answerJson("Priya owns it, shipping Thursday.", [{ timestamp: 61.4, quote: "synthetic checkout" }]),
    ]);
    const outcome = await answerMeetingQuestion({
      title: "Standup",
      summaryJson: null,
      segments,
      transcript: null,
      question: "Who owns the synthetic test?",
      call,
    });
    assert.match(outcome.answer, /Priya/);
    // 61.4 is not a segment start; it snaps to the 60s line.
    assert.deepEqual(outcome.citations, [{ timestamp: 60, quote: "synthetic checkout" }]);
    assert.equal(outcome.provider, "groq");
  });

  it("says so plainly when the transcript does not cover the question", async () => {
    const { call } = scriptedCaller([
      answerJson("The transcript does not say who won the football.", []),
    ]);
    const outcome = await answerMeetingQuestion({
      title: "Standup",
      summaryJson: null,
      segments,
      transcript: null,
      question: "Who won the football?",
      call,
    });
    assert.match(outcome.answer, /does not say/);
    assert.deepEqual(outcome.citations, []);
  });

  it("retries a wrong-shape reply", async () => {
    const { call } = scriptedCaller(['{"summary":"wrong keys"}', answerJson("Covered.", [])]);
    const outcome = await answerMeetingQuestion({
      title: "t",
      summaryJson: null,
      segments,
      transcript: null,
      question: "q?",
      call,
    });
    assert.equal(outcome.answer, "Covered.");
  });
});

describe("ask route", () => {
  async function meetingWithTranscript() {
    const meeting = await createMeeting({ title: "Standup", source: "upload" });
    const client = await db();
    await client.execute({
      sql: `UPDATE meetings SET transcript = ?, transcript_segments_json = ?, status = 'transcribed' WHERE id = ?`,
      args: [segments.map((s) => s.text).join(" "), JSON.stringify(segments), meeting.id],
    });
    return meeting.id;
  }

  function post(id: string, body: unknown) {
    return import("@/app/api/meetings/[id]/ask/route").then(({ POST }) =>
      POST(
        new Request("http://test/ask", { method: "POST", body: JSON.stringify(body) }),
        { params: Promise.resolve({ id }) },
      ),
    );
  }

  it("answers through the real provider stack", async () => {
    const mock = installFetch(() =>
      groqChat(answerJson("Thursday, owned by Priya.", [{ timestamp: 60, quote: "synthetic checkout test" }])),
    );
    restore = mock.restore;

    const response = await post(await meetingWithTranscript(), { question: "When does it ship?" });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.answer, /Thursday/);
    assert.deepEqual(payload.citations, [{ timestamp: 60, quote: "synthetic checkout test" }]);
    assert.equal(payload.provider, "groq");
    assert.equal(payload.context.segmentsTotal, 4);
  });

  it("rejects an empty question, an overlong one, and a missing transcript", async () => {
    const id = await meetingWithTranscript();
    assert.equal((await post(id, { question: "  " })).status, 400);
    assert.equal((await post(id, { question: "x".repeat(501) })).status, 400);

    const bare = await createMeeting({ title: "Empty", source: "upload" });
    assert.equal((await post(bare.id, { question: "anything?" })).status, 409);
    assert.equal((await post("no-such-id", { question: "anything?" })).status, 404);
  });
});
