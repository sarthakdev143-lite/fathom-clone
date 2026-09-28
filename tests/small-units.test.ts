import "./helpers/env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProgressSeconds, parseSilences } from "@/lib/audio-split";
import { isTrustedBlobUrl } from "@/lib/blob-url";
import { createBudget, unlimitedBudget } from "@/lib/budget";
import { summaryRefreshSeconds } from "@/lib/live";
import { buildLivePrompt } from "@/lib/live-summary";
import { clientKey } from "@/lib/rate-limit";
import { baseChunkMs } from "@/lib/use-live-session";
import { downsample, encodeWav } from "@/lib/wav";

describe("blob URL validation (SSRF boundary)", () => {
  it("accepts Vercel Blob URLs", () => {
    assert.equal(
      isTrustedBlobUrl("https://abc123.public.blob.vercel-storage.com/audio/rec-x1Yz.webm"),
      true,
    );
  });

  for (const bad of [
    "http://abc.public.blob.vercel-storage.com/a.webm",
    "https://169.254.169.254/latest/meta-data/",
    "https://evil.com/.public.blob.vercel-storage.com/a",
    "https://abc.public.blob.vercel-storage.com.evil.com/a",
    "https://abc.public.blob.vercel-storage.com/../../etc?x=1",
    "https://user@abc.public.blob.vercel-storage.com/a",
    42,
    null,
  ]) {
    it(`rejects ${String(bad)}`, () => assert.equal(isTrustedBlobUrl(bad), false));
  }
});

describe("wav", () => {
  it("downsamples 48 kHz to 16 kHz by averaging", () => {
    const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1]);
    const out = downsample(input, 48_000, 16_000);
    assert.equal(out.length, 2);
    assert.ok(Math.abs(out[0] - 0.3) < 1e-6);
    assert.ok(Math.abs(out[1] - 1) < 1e-6);
  });

  it("leaves audio at or below the target rate alone", () => {
    const input = new Float32Array([0.1, 0.2]);
    assert.equal(downsample(input, 16_000), input);
  });

  it("writes a valid 16-bit mono header", async () => {
    const blob = encodeWav(new Float32Array(16_000), 16_000);
    const view = new DataView(await blob.arrayBuffer());
    assert.equal(blob.size, 44 + 32_000);
    assert.equal(view.getUint32(24, true), 16_000);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint16(34, true), 16);
  });
});

describe("ffmpeg progress parsing", () => {
  it("takes the last out_time_us", () => {
    const progress = "out_time_us=1000000\nprogress=continue\nout_time_us=899500000\nprogress=end\n";
    assert.equal(parseProgressSeconds(progress), 899.5);
  });

  it("reads out_time_ms from older builds (microseconds despite the name)", () => {
    assert.equal(parseProgressSeconds("out_time_ms=2500000\r\n"), 2.5);
  });

  it("reports zero when nothing was written", () => {
    assert.equal(parseProgressSeconds("progress=end\n"), 0);
  });
});

describe("silence parsing", () => {
  it("pairs starts with ends and closes a trailing open silence", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 0.08",
      "[silencedetect @ 0x1] silence_end: 1.0 | silence_duration: 0.92",
      "[silencedetect @ 0x1] silence_start: 6.4",
    ].join("\n");
    assert.deepEqual(parseSilences(stderr, 10), [
      [0.08, 1],
      [6.4, 10],
    ]);
  });

  it("returns nothing for continuous sound", () => {
    assert.deepEqual(parseSilences("size=N/A time=00:00:10.00", 10), []);
  });
});

describe("budget", () => {
  it("is not exhausted immediately and has a deadline after the soft limit", () => {
    const budget = createBudget({ budgetMs: 10_000 });
    assert.equal(budget.exhausted(), false);
    assert.ok(budget.deadline >= budget.softLimit);
  });

  it("a zero budget is exhausted at once", () => {
    assert.equal(createBudget({ budgetMs: 0 }).exhausted(), true);
  });

  it("unlimited never runs out", () => {
    assert.equal(unlimitedBudget().exhausted(), false);
  });
});

describe("live mode cost controls", () => {
  it("stretches the slice cadence as a meeting runs", () => {
    assert.equal(baseChunkMs(60), 6000);
    assert.equal(baseChunkMs(15 * 60), 10_000);
    assert.equal(baseChunkMs(90 * 60), 15_000);
  });

  it("stretches the summary refresh interval", () => {
    assert.equal(summaryRefreshSeconds(120), 35);
    assert.equal(summaryRefreshSeconds(20 * 60), 60);
    assert.equal(summaryRefreshSeconds(2 * 60 * 60), 120);
  });

  const segs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ start: i * 5, end: i * 5 + 4.5, text: `line ${i} `.padEnd(150, "y") }));

  it("sends the whole transcript while it fits", () => {
    const prompt = buildLivePrompt({ segments: segs(20), previous: null, coveredSeconds: 0 });
    assert.match(prompt, /\[0\.00-4\.50\]/);
    assert.doesNotMatch(prompt, /written earlier/);
  });

  it("switches to a rolling summary for long meetings, with a bounded prompt", () => {
    const all = segs(600); // ~100k characters, ~50 minutes
    const previous = { tldr: "Earlier: budget agreed.", topics: ["Budget"], decisions: [], action_items: [] };
    const prompt = buildLivePrompt({ segments: all, previous, coveredSeconds: 2800 });
    assert.match(prompt, /Earlier: budget agreed/);
    assert.match(prompt, /line 599/);
    assert.doesNotMatch(prompt, /\] line 0 /);
    assert.ok(prompt.length < 26_000, `prompt was ${prompt.length}`);
  });
});

describe("rate limit client key", () => {
  it("uses the first forwarded address", () => {
    const request = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } });
    assert.equal(clientKey(request), "1.2.3.4");
  });

  it("falls back to x-real-ip, then a shared bucket", () => {
    assert.equal(clientKey(new Request("http://x", { headers: { "x-real-ip": "5.6.7.8" } })), "5.6.7.8");
    assert.equal(clientKey(new Request("http://x")), "anonymous");
  });
});
