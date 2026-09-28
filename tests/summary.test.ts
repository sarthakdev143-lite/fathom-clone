import "./helpers/env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_TRANSCRIPT_CHARS,
  WINDOW_CHARS,
  buildReducePrompt,
  buildSectionPrompt,
  buildSummaryPrompt,
  buildWindows,
  fitsSinglePass,
  formatClock,
  parseSummary,
  snapKeyMoments,
} from "@/lib/summary";

const valid = {
  tldr: "Outcome first.",
  topics: ["A", "B"],
  decisions: ["Do X"],
  action_items: [{ task: "Write it", owner: "Priya", due: "Friday" }],
  key_moments: [{ timestamp: 74.5, label: "Decision made" }],
};

function segments(count: number, textLength = 180) {
  return Array.from({ length: count }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 9.5,
    text: `Segment ${i} `.padEnd(textLength, "x"),
  }));
}

describe("parseSummary", () => {
  it("parses a clean object", () => {
    assert.deepEqual(parseSummary(JSON.stringify(valid)), valid);
  });

  it("finds JSON inside markdown fences", () => {
    const raw = "```json\n" + JSON.stringify(valid) + "\n```";
    assert.equal(parseSummary(raw).tldr, "Outcome first.");
  });

  it("finds JSON after leading prose", () => {
    const raw = "Here is the summary you asked for:\n" + JSON.stringify(valid) + "\nHope that helps!";
    assert.equal(parseSummary(raw).decisions[0], "Do X");
  });

  it("ignores braces inside strings when locating the object", () => {
    const tricky = { ...valid, tldr: "Use {curly} braces } carefully {" };
    const raw = "prefix " + JSON.stringify(tricky) + " suffix {";
    assert.equal(parseSummary(raw).tldr, tricky.tldr);
  });

  it("throws on a missing tldr", () => {
    assert.throws(() => parseSummary(JSON.stringify({ ...valid, tldr: "  " })), /tldr/);
  });

  it("throws on an array or non-object", () => {
    assert.throws(() => parseSummary("[1,2,3]"));
    assert.throws(() => parseSummary("no json here"));
  });

  it("throws on an unclosed object", () => {
    assert.throws(() => parseSummary('Sure: {"tldr": "x", "topics": ['), /never closed|JSON/);
  });

  it("drops malformed entries instead of failing the summary", () => {
    const parsed = parseSummary(
      JSON.stringify({
        tldr: "ok",
        topics: ["Real", 42, "", null],
        decisions: "not an array",
        action_items: [{ task: "" }, { owner: "x" }, "string", { task: "Keep me", owner: 5 }],
        key_moments: [{ timestamp: "nope", label: "x" }, { timestamp: 3 }, { timestamp: 9, label: "Kept" }],
      }),
    );
    assert.deepEqual(parsed.topics, ["Real"]);
    assert.deepEqual(parsed.decisions, []);
    assert.deepEqual(parsed.action_items, [{ task: "Keep me", owner: null, due: null }]);
    assert.deepEqual(parsed.key_moments, [{ timestamp: 9, label: "Kept" }]);
  });

  it("accepts clock-style and suffixed timestamps and sorts them", () => {
    const parsed = parseSummary(
      JSON.stringify({
        ...valid,
        key_moments: [
          { timestamp: "1:14", label: "b" },
          { timestamp: "12s", label: "a" },
          { timestamp: "1:00:05", label: "c" },
          { timestamp: -4, label: "negative dropped" },
        ],
      }),
    );
    assert.deepEqual(
      parsed.key_moments.map((m) => m.timestamp),
      [12, 74, 3605],
    );
  });

  it("caps topics and decisions", () => {
    const parsed = parseSummary(
      JSON.stringify({ ...valid, topics: Array(30).fill("t"), decisions: Array(30).fill("d") }),
    );
    assert.equal(parsed.topics.length, 12);
    assert.equal(parsed.decisions.length, 20);
  });
});

describe("windowing", () => {
  it("sends short transcripts in a single pass", () => {
    const input = { title: "t", transcript: "x", segments: segments(10) };
    assert.equal(fitsSinglePass(input), true);
  });

  it("splits long transcripts into windows that cover every segment exactly once", () => {
    const segs = segments(400); // ~80k characters
    const input = { title: "t", transcript: segs.map((s) => s.text).join(" "), segments: segs };
    assert.equal(fitsSinglePass(input), false);

    const windows = buildWindows(input);
    assert.ok(windows.length > 1);
    for (const w of windows) assert.ok(w.body.length <= WINDOW_CHARS, `window ${w.label} too large`);

    const lines = windows.flatMap((w) => w.body.split("\n"));
    assert.equal(lines.length, segs.length);
    assert.equal(lines[0].startsWith("[0.00-9.50]"), true);
    assert.equal(windows[0].start, 0);
    assert.equal(windows.at(-1)!.end, segs.at(-1)!.end);
  });

  it("is deterministic, which is what makes map progress resumable", () => {
    const segs = segments(300);
    const input = { title: "t", transcript: "", segments: segs };
    assert.deepEqual(buildWindows(input), buildWindows(input));
  });

  it("splits a transcript without timings on sentence boundaries", () => {
    const sentence = "This is one sentence about the plan. ";
    const transcript = sentence.repeat(1500); // ~55k chars
    const windows = buildWindows({ title: "t", transcript, segments: [] });
    assert.ok(windows.length >= 3);
    for (const w of windows) {
      assert.ok(w.body.length <= WINDOW_CHARS);
      assert.equal(w.start, null);
      assert.ok(w.body.endsWith("."));
    }
    assert.equal(
      windows.map((w) => w.body).join(" ").replace(/\s+/g, " "),
      transcript.trim().replace(/\s+/g, " "),
    );
  });

  it("section prompts name their span", () => {
    const segs = segments(300);
    const [first] = buildWindows({ title: "t", transcript: "", segments: segs });
    const prompt = buildSectionPrompt({ title: "Standup", window: first, index: 0, total: 4 });
    assert.match(prompt, /section 1 of 4/);
    assert.match(prompt, new RegExp(first.label));
  });

  it("the reduce prompt includes every section in order", () => {
    const prompt = buildReducePrompt({
      title: "Standup",
      sections: [
        { label: "00:00-15:00", summary: { ...valid, tldr: "first" } },
        { label: "15:00-30:00", summary: { ...valid, tldr: "second" } },
      ],
    });
    assert.ok(prompt.indexOf("first") < prompt.indexOf("second"));
    assert.match(prompt, /Section 2 \(15:00-30:00\)/);
  });

  it("the legacy single-prompt builder still samples, for live previews", () => {
    const segs = segments(400);
    const built = buildSummaryPrompt({ title: "t", transcript: "", segments: segs });
    assert.equal(built.sampled, true);
    assert.ok(built.prompt.length < MAX_TRANSCRIPT_CHARS + 500);
  });
});

describe("snapKeyMoments", () => {
  const segs = [{ start: 0 }, { start: 10.2 }, { start: 31.7 }, { start: 60 }];

  it("moves each moment onto the nearest real segment start", () => {
    const snapped = snapKeyMoments(
      [
        { timestamp: 11, label: "a" },
        { timestamp: 58, label: "b" },
      ],
      segs,
    );
    assert.deepEqual(snapped.map((m) => m.timestamp), [10.2, 60]);
  });

  it("removes moments that collapse onto the same line", () => {
    const snapped = snapKeyMoments(
      [
        { timestamp: 30, label: "a" },
        { timestamp: 33, label: "b" },
      ],
      segs,
    );
    assert.equal(snapped.length, 1);
  });

  it("returns nothing without timings", () => {
    assert.deepEqual(snapKeyMoments([{ timestamp: 3, label: "a" }], []), []);
  });
});

describe("formatClock", () => {
  it("formats minutes and hours", () => {
    assert.equal(formatClock(75), "01:15");
    assert.equal(formatClock(3725), "1:02:05");
  });
});
