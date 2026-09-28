import {
  ensureLocalAudio,
  extractChunk,
  findSilenceCut,
  meetingWorkDir,
  removeWorkDir,
  resolveFfmpeg,
} from "./audio-split";
import { assertTrustedBlobUrl } from "./blob-url";
import { unlimitedBudget, type Budget } from "./budget";
import { GROQ_MAX_UPLOAD_BYTES, looksLikeSpeech } from "./groq";
import { logEvent } from "./log";
import {
  getLegacyAudioBlob,
  loadAudio,
  readProgress,
  requireMeeting,
  saveTranscript,
  writeProgress,
  type TranscriptSegment,
} from "./meetings";
import { isTransientProviderError, transcribeAudio } from "./providers";

/**
 * Step 2 for audio of any length.
 *
 * Small files go to the provider whole, exactly as before. Anything larger is
 * cut into fixed-length chunks with ffmpeg, each chunk is transcribed on its
 * own, and the segment offsets are shifted back onto the meeting's timeline.
 * That removes both ceilings that used to apply: Groq's 25 MB upload cap
 * (about 70 minutes of browser Opus) and Gemini's 14 MB inline cap.
 *
 * Progress is written after every chunk. A request that runs out of time
 * returns `done: false`, and the next request continues from the first
 * unprocessed second rather than starting over.
 */

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 15 minutes of 16 kHz mono Opus at 32 kbit/s is about 3.5 MB. Long enough
 * that chunk seams are rare (one every quarter hour), short enough that a
 * chunk transcribes in seconds and fits every provider's limit.
 */
export const CHUNK_SECONDS = () => envNumber("TRANSCRIBE_CHUNK_SECONDS", 900);

/** Fits inline on both providers, so no splitting is needed below this. */
export const SINGLE_SHOT_MAX_BYTES = () =>
  envNumber("TRANSCRIBE_SINGLE_SHOT_MAX_BYTES", 14 * 1024 * 1024);

/** A chunk shorter than this is the tail end of the file. */
const MIN_CHUNK_SECONDS = 0.5;

/** How far back from a nominal boundary to look for a pause to cut in. */
const SILENCE_SEARCH_SECONDS = 20;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class NoSpeechError extends Error {
  constructor() {
    super("No speech was detected in this audio.");
    this.name = "NoSpeechError";
  }
}

export class AudioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioUnavailableError";
  }
}

interface TranscriptProgress {
  v: 1;
  chunkSeconds: number;
  /** Seconds of source audio already transcribed. */
  nextOffset: number;
  chunks: number;
  segments: TranscriptSegment[];
  texts: string[];
  language: string | null;
  usedGemini: boolean;
  fallbackReason: string | null;
}

export interface TranscriptSummary {
  characters: number;
  segments: number;
  language: string | null;
  duration: number | null;
  provider: string;
  fallbackReason: string | null;
  chunks: number;
}

export type TranscribeStep =
  | { done: true; transcript: TranscriptSummary }
  | {
      done: false;
      processedSeconds: number;
      chunks: number;
      retryAfterSeconds?: number;
    };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function transcribeMeetingStep(
  id: string,
  options: { budget?: Budget; onUnit?: () => Promise<void> } = {},
): Promise<TranscribeStep> {
  const budget = options.budget ?? unlimitedBudget();
  const meeting = await requireMeeting(id);
  const chunkSeconds = CHUNK_SECONDS();

  let progress = await readProgress<TranscriptProgress>(id, "transcript_progress_json");
  if (progress && (progress.v !== 1 || progress.chunkSeconds !== chunkSeconds)) {
    progress = null;
  }

  let legacyBytes: Uint8Array | null = null;
  if (!meeting.audio_url) {
    legacyBytes = await getLegacyAudioBlob(id);
    if (!legacyBytes) {
      throw new AudioUnavailableError("This meeting has no stored audio to transcribe.");
    }
  }

  const knownBytes = meeting.audio_bytes ?? legacyBytes?.byteLength ?? null;
  const ffmpeg = resolveFfmpeg();

  const singleShot =
    !progress &&
    knownBytes !== null &&
    (knownBytes <= SINGLE_SHOT_MAX_BYTES() || (!ffmpeg && knownBytes <= GROQ_MAX_UPLOAD_BYTES));

  if (singleShot) {
    return transcribeWhole(id, meeting.duration_seconds, budget);
  }

  if (!ffmpeg) {
    throw new Error(
      `This recording is ${((knownBytes ?? 0) / 1024 / 1024).toFixed(1)} MB. Audio over ` +
        `${(GROQ_MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB has to be split before ` +
        "transcription, and ffmpeg is not available on this server. Set FFMPEG_PATH or " +
        "reinstall dependencies so ffmpeg-static can download its binary.",
    );
  }

  const workDir = await meetingWorkDir(id);
  const inputPath = await ensureLocalAudio({
    workDir,
    expectedBytes: knownBytes,
    url: meeting.audio_url ? assertTrustedBlobUrl(meeting.audio_url) : null,
    bytes: legacyBytes,
  });

  const state: TranscriptProgress = progress ?? {
    v: 1,
    chunkSeconds,
    nextOffset: 0,
    chunks: 0,
    segments: [],
    texts: [],
    language: null,
    usedGemini: false,
    fallbackReason: null,
  };

  let unitsThisRequest = 0;

  for (;;) {
    if (unitsThisRequest > 0 && budget.exhausted()) {
      return { done: false, processedSeconds: state.nextOffset, chunks: state.chunks };
    }

    const offset = state.nextOffset;
    const started = Date.now();

    // End the chunk in a pause near the nominal boundary rather than
    // mid-word. Past the end of the file there is nothing to analyse and the
    // fixed length is used, which the extract below then truncates.
    const cut = await findSilenceCut({
      ffmpeg,
      inputPath,
      targetSeconds: offset + chunkSeconds,
      windowSeconds: Math.min(SILENCE_SEARCH_SECONDS, chunkSeconds / 4),
    });
    const requested =
      cut !== null && cut - offset >= chunkSeconds / 2 ? round3(cut - offset) : chunkSeconds;

    const chunk = await extractChunk({
      ffmpeg,
      inputPath,
      startSeconds: offset,
      durationSeconds: requested,
      workDir,
    });

    if (chunk.seconds < MIN_CHUNK_SECONDS) break;

    // A full chunk covers exactly `requested` seconds of the source - that is
    // what was asked for with -ss/-t - even though ffmpeg reports a few ms
    // less for Opus (frame padding). Advancing by the reported figure would
    // drift the timeline ~20 ms per chunk and overlap the next one. Only the
    // final, partial chunk uses its measured length.
    const isFull = chunk.seconds >= requested - 1;
    const span = isFull ? requested : chunk.seconds;

    let result;
    try {
      result = await transcribeAudio({
        audio: chunk.bytes,
        filename: "chunk.ogg",
        mimeType: "audio/ogg",
        deadline: budget.deadline,
      });
    } catch (err) {
      if (isTransientProviderError(err)) {
        // Every provider is rate limited or down. What has been done so far is
        // saved, so this is a pause rather than a failure.
        logEvent("warn", "transcribe.chunk_deferred", { meetingId: id, offset });
        return {
          done: false,
          processedSeconds: state.nextOffset,
          chunks: state.chunks,
          retryAfterSeconds: 20,
        };
      }
      throw err;
    }

    // A silent stretch (a break, a muted mic) comes back from Whisper as "." or
    // "Thank you." - the same hallucination the whole-file path screens out.
    if (looksLikeSpeech(result.text, chunk.seconds)) {
      const segments: TranscriptSegment[] =
        result.segments.length > 0
          ? result.segments
              // A segment past the chunk's real end cannot exist in the audio;
              // keeping it would put a line after the recording finishes.
              .filter((segment) => segment.start < span)
              .map((segment) => ({
                start: round2(offset + segment.start),
                end: round2(offset + Math.min(segment.end, span)),
                text: segment.text,
              }))
          : [{ start: round2(offset), end: round2(offset + span), text: result.text }];
      state.segments.push(...segments);
      state.texts.push(result.text);
    }

    state.language ??= result.language;
    if (result.provider === "gemini") {
      state.usedGemini = true;
      state.fallbackReason ??= result.fallbackReason;
    }
    state.nextOffset = round3(offset + span);
    state.chunks += 1;
    unitsThisRequest += 1;

    await writeProgress(id, "transcript_progress_json", state);
    await options.onUnit?.();

    logEvent("info", "transcribe.chunk_done", {
      meetingId: id,
      chunk: state.chunks,
      offset,
      seconds: chunk.seconds,
      bytes: chunk.bytes.byteLength,
      provider: result.provider,
      ms: Date.now() - started,
    });

    if (!isFull) break;
  }

  const text = state.texts.join(" ").trim();
  if (!looksLikeSpeech(text, state.nextOffset)) {
    await writeProgress(id, "transcript_progress_json", null);
    await removeWorkDir(id);
    throw new NoSpeechError();
  }

  const provider = state.usedGemini ? "gemini" : "groq";
  await saveTranscript(
    id,
    {
      text,
      language: state.language,
      duration: state.nextOffset,
      segments: state.segments,
    },
    { provider, fallbackReason: state.fallbackReason },
  );
  await removeWorkDir(id);

  return {
    done: true,
    transcript: {
      characters: text.length,
      segments: state.segments.length,
      language: state.language,
      duration: state.nextOffset,
      provider,
      fallbackReason: state.fallbackReason,
      chunks: state.chunks,
    },
  };
}

/** The original whole-file path, unchanged in behaviour. */
async function transcribeWhole(
  id: string,
  knownDuration: number | null,
  budget: Budget,
): Promise<TranscribeStep> {
  const meeting = await requireMeeting(id);
  let audio;
  try {
    audio = await loadAudio(meeting);
  } catch (err) {
    throw new AudioUnavailableError(err instanceof Error ? err.message : "Audio unavailable.");
  }
  if (!audio) throw new AudioUnavailableError("This meeting has no stored audio to transcribe.");

  let result;
  try {
    result = await transcribeAudio({
      audio: audio.bytes,
      filename: audio.filename,
      mimeType: audio.mimeType,
      deadline: budget.deadline,
    });
  } catch (err) {
    if (isTransientProviderError(err)) {
      return { done: false, processedSeconds: 0, chunks: 0, retryAfterSeconds: 20 };
    }
    throw err;
  }

  if (!looksLikeSpeech(result.text, result.duration ?? knownDuration)) {
    throw new NoSpeechError();
  }

  await saveTranscript(
    id,
    {
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
    },
    { provider: result.provider, fallbackReason: result.fallbackReason },
  );

  return {
    done: true,
    transcript: {
      characters: result.text.length,
      segments: result.segments.length,
      language: result.language,
      duration: result.duration,
      provider: result.provider,
      fallbackReason: result.fallbackReason,
      chunks: 1,
    },
  };
}
