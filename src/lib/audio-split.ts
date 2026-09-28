import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import ffmpegStatic from "ffmpeg-static";

/**
 * Splits long audio into transcribable chunks with ffmpeg.
 *
 * Why ffmpeg on the server rather than anything in the browser: uploads can be
 * any container the browser plays (webm, m4a, mp4 video, wav...), and a WebM
 * from MediaRecorder has no cues or duration, so it cannot be cut by byte
 * offset. Decoding and re-encoding is the only way to get self-contained
 * pieces, and doing it here keeps one code path for recordings and uploads.
 *
 * Each chunk is re-encoded to 16 kHz mono Opus at 32 kbit/s. Whisper resamples
 * everything to 16 kHz mono internally, so nothing it would use is lost, and a
 * 15-minute chunk comes out around 3.5 MB - comfortably inside both Groq's
 * 25 MB and Gemini's 14 MB inline limits.
 */

export function resolveFfmpeg(): string | null {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (ffmpegStatic && existsSync(ffmpegStatic)) return ffmpegStatic;
  return null;
}

export class FfmpegError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "FfmpegError";
    this.stderr = stderr;
  }
}

export interface ExtractedChunk {
  bytes: Uint8Array;
  /** Seconds of audio actually written, as reported by ffmpeg. */
  seconds: number;
}

/**
 * Parses ffmpeg's `-progress` output. `out_time_us` is the authoritative
 * position; older builds report the same value (despite the name) as
 * `out_time_ms`.
 */
export function parseProgressSeconds(progress: string): number {
  let maxUs = 0;
  for (const line of progress.split(/\r?\n/)) {
    const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
    if (match) maxUs = Math.max(maxUs, Number(match[1]));
  }
  return maxUs / 1_000_000;
}

/**
 * Extracts `[startSeconds, startSeconds + durationSeconds)` of `inputPath` as a
 * standalone Ogg/Opus file. Returns zero seconds once `startSeconds` is past
 * the end of the audio, which is how the caller detects the last chunk -
 * MediaRecorder WebM has no reliable duration to ask for up front.
 */
export async function extractChunk(input: {
  ffmpeg: string;
  inputPath: string;
  startSeconds: number;
  durationSeconds: number;
  workDir: string;
}): Promise<ExtractedChunk> {
  const outPath = path.join(
    input.workDir,
    `chunk-${Math.round(input.startSeconds * 1000)}-${process.pid}-${Date.now()}.ogg`,
  );

  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    // Input seeking: fast, and exact for audio because it is re-encoded.
    "-ss",
    input.startSeconds.toFixed(3),
    "-i",
    input.inputPath,
    "-t",
    input.durationSeconds.toFixed(3),
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    "-application",
    "voip",
    "-f",
    "ogg",
    "-progress",
    "pipe:1",
    "-nostats",
    "-y",
    outPath,
  ];

  const { stdout, stderr, code } = await run(input.ffmpeg, args);

  try {
    if (code !== 0) {
      throw new FfmpegError(
        `ffmpeg could not decode the audio (exit ${code}). ${stderr.trim().split("\n").pop() ?? ""}`.trim(),
        stderr,
      );
    }

    const seconds = parseProgressSeconds(stdout);
    if (seconds <= 0 || !existsSync(outPath)) {
      return { bytes: new Uint8Array(0), seconds: 0 };
    }

    const bytes = new Uint8Array(await readFile(outPath));
    return { bytes, seconds };
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }
}

/**
 * Parses silencedetect output into [start, end] pairs. A silence still open at
 * the end of the analysed range has no `silence_end`, so it closes at `until`.
 */
export function parseSilences(stderr: string, until: number): [number, number][] {
  const silences: [number, number][] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      open = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && open !== null) {
      silences.push([open, Number(end[1])]);
      open = null;
    }
  }
  if (open !== null && open < until) silences.push([open, until]);
  return silences;
}

/**
 * Picks where to cut near `targetSeconds`: the middle of the pause closest to
 * the target within the preceding `windowSeconds`. Cutting a fixed length
 * would split words ("rules engine" came back as "rules and | engine" in
 * testing); cutting in a pause does not. Returns null when the window has no
 * pause, and the caller falls back to the fixed cut.
 */
export async function findSilenceCut(input: {
  ffmpeg: string;
  inputPath: string;
  targetSeconds: number;
  windowSeconds: number;
}): Promise<number | null> {
  const from = Math.max(0, input.targetSeconds - input.windowSeconds);
  const length = input.targetSeconds - from;
  if (length <= 0) return null;

  const { stderr, code } = await run(input.ffmpeg, [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-ss",
    from.toFixed(3),
    "-t",
    length.toFixed(3),
    "-i",
    input.inputPath,
    "-vn",
    "-af",
    "silencedetect=noise=-35dB:d=0.25",
    "-f",
    "null",
    "-",
  ]);
  if (code !== 0) return null;

  const silences = parseSilences(stderr, length);
  if (silences.length === 0) return null;

  // Latest pause wins: the chunk stays as close to full length as possible.
  const [start, end] = silences[silences.length - 1];
  return Math.round((from + (start + end) / 2) * 1000) / 1000;
}

function run(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      // Bounded: a corrupt file can make ffmpeg print an error per packet.
      if (stderr.length < 20_000) stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/** Scratch space for one meeting's audio. /tmp is the only writable path on Vercel. */
export async function meetingWorkDir(meetingId: string): Promise<string> {
  const dir = path.join(tmpdir(), "fathom-clone", meetingId.replace(/[^a-zA-Z0-9-]/g, ""));
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeWorkDir(meetingId: string): Promise<void> {
  const dir = path.join(tmpdir(), "fathom-clone", meetingId.replace(/[^a-zA-Z0-9-]/g, ""));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Makes sure the source audio is on local disk, streaming it rather than
 * buffering it, so a 200 MB upload does not need 200 MB of function memory.
 * A copy left by an earlier request on the same warm instance is reused when
 * its size matches.
 */
export async function ensureLocalAudio(input: {
  workDir: string;
  expectedBytes: number | null;
  url?: string | null;
  bytes?: Uint8Array | null;
}): Promise<string> {
  const target = path.join(input.workDir, "source.audio");

  const existing = await stat(target).catch(() => null);
  if (
    existing &&
    existing.size > 0 &&
    (input.expectedBytes === null || existing.size === input.expectedBytes)
  ) {
    return target;
  }

  if (input.bytes) {
    await writeFile(target, input.bytes);
    return target;
  }

  if (!input.url) throw new Error("No audio source to download.");

  const response = await fetch(input.url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not read the stored audio (HTTP ${response.status}). ` +
        "The blob may have been deleted, in which case the meeting must be re-uploaded.",
    );
  }

  const partial = `${target}.part`;
  await pipeline(
    Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
    createWriteStream(partial),
  );
  // Rename-on-complete, so a download killed half-way is never mistaken for
  // a complete file by the next request.
  await rm(target, { force: true });
  await rename(partial, target);
  return target;
}
