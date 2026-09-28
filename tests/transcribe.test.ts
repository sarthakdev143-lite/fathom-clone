import "./helpers/env";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { resolveFfmpeg } from "@/lib/audio-split";
import { createBudget } from "@/lib/budget";
import { createMeeting, getMeeting, getSegments, readProgress } from "@/lib/meetings";
import { NoSpeechError, transcribeMeetingStep } from "@/lib/transcribe";
import { GROQ_TRANSCRIBE, groqTranscription, installFetch, json } from "./helpers/fetch";

/**
 * Exercises the real ffmpeg split on a real encoded file; only the network is
 * faked. Chunks are shortened to 30 s so a 70 s file yields three of them.
 */

const ffmpeg = resolveFfmpeg();
const BLOB_URL = "https://teststore.public.blob.vercel-storage.com/audio/meeting-abc.webm";
let audioFile: Uint8Array;
let restore: (() => void) | null = null;

before(() => {
  if (!ffmpeg) return;
  const dir = mkdtempSync(path.join(tmpdir(), "fathom-audio-"));
  const out = path.join(dir, "meeting.webm");
  // 70 s of tone, encoded the way MediaRecorder encodes: Opus in WebM.
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=70",
    "-c:a", "libopus", "-b:a", "48k", "-f", "webm", "-y", out,
  ]);
  audioFile = new Uint8Array(readFileSync(out));
  process.env.TRANSCRIBE_CHUNK_SECONDS = "30";
});

after(() => {
  delete process.env.TRANSCRIBE_CHUNK_SECONDS;
  delete process.env.TRANSCRIBE_SINGLE_SHOT_MAX_BYTES;
});

afterEach(() => {
  restore?.();
  restore = null;
  delete process.env.TRANSCRIBE_SINGLE_SHOT_MAX_BYTES;
});

/** Fakes blob storage and Groq; each chunk's transcript names its call. */
function fakeNetwork(options: { speech?: (n: number) => string; groqStatus?: (n: number) => number } = {}) {
  let groqCalls = 0;
  const bodies: number[] = [];
  const mock = installFetch(async (url, init) => {
    if (url === BLOB_URL) return new Response(audioFile as BodyInit, { status: 200 });
    if (url.startsWith(GROQ_TRANSCRIBE)) {
      groqCalls++;
      const file = (init?.body as FormData).get("file") as Blob;
      bodies.push(file.size);
      const status = options.groqStatus?.(groqCalls) ?? 200;
      if (status !== 200) return json({ error: { message: "limited" } }, status, { "retry-after": "0.01" });
      const text = options.speech?.(groqCalls) ?? `This is chunk number ${groqCalls} of the planning meeting speaking.`;
      return groqTranscription({
        text,
        segments: [
          { start: 0, end: 4, text },
          { start: 20, end: 29.5, text: `later in chunk ${groqCalls}` },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  restore = mock.restore;
  return { mock, groq: () => groqCalls, bodies };
}

async function uploadedMeeting() {
  return createMeeting({
    title: "Chunked",
    source: "upload",
    audioUrl: BLOB_URL,
    audioBytes: audioFile.byteLength,
    audioMime: "audio/webm",
    audioFilename: "meeting.webm",
  });
}

describe("transcribeMeetingStep", { skip: ffmpeg ? false : "ffmpeg not available" }, () => {
  it("sends small files whole, as before", async () => {
    const net = fakeNetwork();
    const meeting = await uploadedMeeting();
    const step = await transcribeMeetingStep(meeting.id);
    assert.equal(step.done, true);
    assert.equal(net.groq(), 1);
    assert.equal(net.bodies[0], audioFile.byteLength, "the original file, not a re-encode");
  });

  it("splits large audio into chunks and shifts offsets onto one timeline", async () => {
    process.env.TRANSCRIBE_SINGLE_SHOT_MAX_BYTES = "1";
    const net = fakeNetwork();
    const meeting = await uploadedMeeting();

    const step = await transcribeMeetingStep(meeting.id);
    assert.ok(step.done);
    assert.equal(step.transcript.chunks, 3);
    assert.equal(net.groq(), 3);
    assert.ok(Math.abs((step.transcript.duration ?? 0) - 70) < 1, `duration ${step.transcript.duration}`);

    const segs = await getSegments(meeting.id);
    assert.deepEqual(
      segs.map((s) => s.start),
      [0, 20, 30, 50, 60, 80].filter((t) => t < 70.5),
    );
    // The last chunk is 10 s long, so its 20-29.5 segment is outside the audio
    // and must not be stretched past the end.
    assert.ok(segs.every((s) => s.end <= 70.5));

    const row = await getMeeting(meeting.id);
    assert.equal(row?.status, "transcribed");
    assert.equal(row?.transcript_provider, "groq");
    assert.match(row?.transcript ?? "", /chunk number 1.*chunk number 3/);
    assert.equal(await readProgress(meeting.id, "transcript_progress_json"), null);
  });

  it("resumes chunk by chunk across budget-limited requests", async () => {
    process.env.TRANSCRIBE_SINGLE_SHOT_MAX_BYTES = "1";
    const net = fakeNetwork();
    const meeting = await uploadedMeeting();
    const tight = () => createBudget({ budgetMs: 0 });

    const a = await transcribeMeetingStep(meeting.id, { budget: tight() });
    const b = await transcribeMeetingStep(meeting.id, { budget: tight() });
    const c = await transcribeMeetingStep(meeting.id, { budget: tight() });

    assert.deepEqual(
      [a, b].map((s) => (s.done ? "done" : s.processedSeconds)),
      [30, 60],
    );
    assert.equal(c.done, true);
    assert.equal(net.groq(), 3, "no chunk is transcribed twice");
  });

  it("pauses on a rate limit without losing finished chunks", async () => {
    process.env.TRANSCRIBE_SINGLE_SHOT_MAX_BYTES = "1";
    // Chunk 2's first call gets 429s until the retry budget is spent.
    fakeNetwork({ groqStatus: (n) => (n >= 2 && n <= 6 ? 429 : 200) });
    const meeting = await uploadedMeeting();

    const paused = await transcribeMeetingStep(meeting.id);
    assert.equal(paused.done, false);
    if (!paused.done) {
      assert.equal(paused.processedSeconds, 30);
      assert.equal(paused.retryAfterSeconds, 20);
    }

    const resumed = await transcribeMeetingStep(meeting.id);
    assert.equal(resumed.done, true);
    const segs = await getSegments(meeting.id);
    assert.equal(segs[0].start, 0);
    assert.equal(segs[2].start, 30);
  });

  it("cuts chunks in a pause near the boundary instead of mid-word", async () => {
    process.env.TRANSCRIBE_SINGLE_SHOT_MAX_BYTES = "1";
    // 25 s tone, 2 s pause, 43 s tone: the nominal 30 s cut lands in sound,
    // the pause at 25-27 s is inside the search window.
    const dir = mkdtempSync(path.join(tmpdir(), "fathom-audio-"));
    const out = path.join(dir, "paused.webm");
    execFileSync(ffmpeg!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=25:sample_rate=48000",
      "-f", "lavfi", "-t", "2", "-i", "anullsrc=r=48000:cl=mono",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=43:sample_rate=48000",
      "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1",
      "-c:a", "libopus", "-b:a", "48k", "-f", "webm", "-y", out,
    ]);
    const saved = audioFile;
    audioFile = new Uint8Array(readFileSync(out));
    try {
      fakeNetwork();
      const meeting = await uploadedMeeting();
      const step = await transcribeMeetingStep(meeting.id);
      assert.ok(step.done);
      const starts = (await getSegments(meeting.id)).map((s) => s.start);
      assert.ok(Math.abs(starts[2] - 26) < 0.3, `second chunk starts at ${starts[2]}, expected ~26`);
      assert.ok(Math.abs((step.transcript.duration ?? 0) - 70) < 1);
    } finally {
      audioFile = saved;
    }
  });

  it("drops hallucinated filler from silent chunks, and rejects all-silent audio", async () => {
    process.env.TRANSCRIBE_SINGLE_SHOT_MAX_BYTES = "1";
    fakeNetwork({ speech: (n) => (n === 2 ? "." : `Real speech in chunk ${n}, discussing the roadmap.`) });
    const meeting = await uploadedMeeting();
    const step = await transcribeMeetingStep(meeting.id);
    assert.ok(step.done);
    const segs = await getSegments(meeting.id);
    assert.ok(segs.every((s) => s.start < 30 || s.start >= 60), "chunk 2 contributed nothing");

    restore?.();
    fakeNetwork({ speech: () => "." });
    const silent = await uploadedMeeting();
    await assert.rejects(transcribeMeetingStep(silent.id), (err: unknown) => err instanceof NoSpeechError);
  });
});
