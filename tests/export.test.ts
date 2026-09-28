import "./helpers/env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exportFilename,
  formatClock,
  formatSrtTime,
  slugify,
  transcriptToMarkdown,
  transcriptToSrt,
  transcriptToText,
} from "@/lib/export";

const segments = [
  { start: 0, end: 6.16, text: "Alright everyone, thanks for joining." },
  { start: 74.5, end: 80, text: "We agreed to ship on Friday." },
];

describe("export formatters", () => {
  it("writes timestamped text lines", () => {
    assert.equal(
      transcriptToText({ segments, plainText: null }),
      "[00:00] Alright everyone, thanks for joining.\n[01:14] We agreed to ship on Friday.",
    );
  });

  it("falls back to the plain transcript without segments", () => {
    assert.equal(transcriptToText({ segments: [], plainText: "hello" }), "hello");
    assert.equal(transcriptToText({ segments: [], plainText: null }), "");
  });

  it("writes markdown with summary and transcript sections", () => {
    const md = transcriptToMarkdown({
      title: "Standup",
      date: "Sep 26",
      language: "English",
      tldr: "Outcome first.",
      segments,
      plainText: null,
    });
    assert.match(md, /^# Standup\n/);
    assert.match(md, /## Summary\n\nOutcome first\./);
    assert.match(md, /\*\*\[01:14\]\*\* We agreed to ship on Friday\./);
  });

  it("writes markdown without a summary or segments", () => {
    const md = transcriptToMarkdown({
      title: "t",
      date: "d",
      language: null,
      tldr: null,
      segments: [],
      plainText: "just words",
    });
    assert.doesNotMatch(md, /## Summary/);
    assert.match(md, /just words/);
  });

  it("writes valid SRT with comma decimals and 1-based numbering", () => {
    assert.equal(
      transcriptToSrt(segments),
      "1\n00:00:00,000 --> 00:00:06,160\nAlright everyone, thanks for joining.\n\n" +
        "2\n00:01:14,500 --> 00:01:20,000\nWe agreed to ship on Friday.\n\n",
    );
  });

  it("refuses SRT without timings rather than writing a lie", () => {
    assert.equal(transcriptToSrt([]), null);
  });

  it("formats SRT times with hours and milliseconds", () => {
    assert.equal(formatSrtTime(3725.25), "01:02:05,250");
    assert.equal(formatSrtTime(-3), "00:00:00,000");
  });

  it("builds safe filenames", () => {
    assert.equal(exportFilename("Q3 checkout planning sync!", "md"), "q3-checkout-planning-sync.md");
    assert.equal(exportFilename("  ", "srt"), "meeting.srt");
    assert.equal(formatClock(75), "01:15");
    assert.equal(slugify("A".repeat(200)).length <= 80, true);
  });
});
