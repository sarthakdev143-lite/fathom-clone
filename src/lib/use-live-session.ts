"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav } from "@/lib/wav";

/**
 * Live mode: captions and a running summary while the meeting is still being
 * recorded.
 *
 * Transport is polling rather than Server-Sent Events. A recording can run for
 * half an hour, and a Vercel function is terminated when it exceeds its duration
 * limit, so an SSE connection cannot outlive a meeting. Polling every two
 * seconds keeps each request short and bounded.
 *
 * Audio is tapped as raw PCM through an AudioWorklet and encoded as a
 * self-contained WAV per slice, rather than slicing the MediaRecorder output. A
 * WebM stream is not a valid media file until recording stops: both a bare
 * cluster and a header-prefixed cluster were rejected by Whisper as
 * `invalid_media_file`.
 */

/** Baseline audio per slice when everything is healthy. */
const CHUNK_SECONDS = 6;
/** How often to ask the server for new captions and a new summary. */
const POLL_MS = 2000;

/**
 * Rate-limit backoff for the chunk cadence. A 429 or 5xx from Groq doubles the
 * delay up to a ceiling, and any successful slice resets it. This only governs
 * how often the *live preview* is refreshed; the authoritative transcribe and
 * summary after recording stops are separate requests with their own retry
 * policy and are deliberately unaffected.
 */
const MAX_CHUNK_INTERVAL_MS = 60_000;

/**
 * Hard cap on how much audio one slice may carry, regardless of how long the
 * client slept. This is load-bearing: at the 60s backoff ceiling a slice would
 * otherwise hold a full minute of 48 kHz 16-bit audio, which is about 5.8 MB and
 * is rejected by the server's 4 MB chunk limit. Every post-backoff request would
 * then fail, so the live captions would die precisely when the safety net was
 * supposed to help. The buffer is trimmed to the most recent
 * MAX_SLICE_SECONDS rather than the oldest, because for a live view recent
 * context matters more, and the dropped span is visible as a gap in the
 * timestamps.
 */
const MAX_SLICE_SECONDS = 20;

/**
 * Live updates stop after this much continuous recording. The recording itself
 * and the eventual authoritative transcript are unaffected - this only caps the
 * number of extra model calls a long meeting incurs.
 */
const LIVE_CEILING_SECONDS = 20 * 60;

const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

export interface LiveCaption {
  start: number;
  end: number;
  text: string;
}

export interface LiveSummary {
  tldr: string;
  topics: string[];
  decisions: string[];
  action_items: { task: string; owner: string | null; due: string | null }[];
}

interface LiveDelta {
  status: string;
  liveSeq: number;
  summarySeq: number;
  audioSeconds: number;
  segments: LiveCaption[];
  summary: LiveSummary | null;
  error: string | null;
}

export function useLiveSession() {
  const [liveId, setLiveId] = useState<string | null>(null);
  const [captions, setCaptions] = useState<LiveCaption[]>([]);
  const [summary, setSummary] = useState<LiveSummary | null>(null);
  const [audioSeconds, setAudioSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [summarySeq, setSummarySeq] = useState(0);
  /** Set once the ceiling is hit, so the UI can say why updates stopped. */
  const [paused, setPaused] = useState(false);

  const workletRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(48000);
  /** Audio already sent, so each slice continues the timeline. */
  const sentSecondsRef = useRef(0);
  /** Total recorded, which is ahead of what has been transcribed. */
  const recordedSecondsRef = useRef(0);
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Bumped to cancel the chunk loop; see runChunkLoop. */
  const generationRef = useRef(0);
  /** Pending delay resolvers, so teardown can wake the loop immediately. */
  const sleepersRef = useRef<(() => void)[]>([]);
  const inFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const liveIdRef = useRef<string | null>(null);
  const seenSegmentsRef = useRef(0);
  const seenSummaryRef = useRef(0);
  /** Current chunk cadence, which backs off on rate limits. */
  const chunkIntervalRef = useRef(CHUNK_SECONDS * 1000);
  const pausedRef = useRef(false);

  const clearChunkTimer = useCallback(() => {
    // Cancels the loop wherever it is, including mid-delay.
    generationRef.current += 1;
    if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
    chunkTimerRef.current = null;
    const pending = sleepersRef.current;
    sleepersRef.current = [];
    for (const wake of pending) wake();
  }, []);

  /**
   * Doubles the chunk cadence up to the ceiling. Reported rather than surfaced
   * as an error: a rate limit is a condition to ride out, not something the
   * person recording needs interrupting them over.
   */
  const backOff = useCallback(
    (reason: string) => {
      const previous = chunkIntervalRef.current;
      chunkIntervalRef.current = Math.min(MAX_CHUNK_INTERVAL_MS, previous * 2);
      console.info(
        `[live] backing off chunk cadence ${previous}ms -> ${chunkIntervalRef.current}ms (${reason})`,
      );
    },
    [],
  );

  const resetCadence = useCallback(() => {
    // Only report an actual change, otherwise every healthy slice logs.
    if (chunkIntervalRef.current === CHUNK_SECONDS * 1000) return;
    const previous = chunkIntervalRef.current;
    chunkIntervalRef.current = CHUNK_SECONDS * 1000;
    console.info(
      `[live] upstream recovered, chunk cadence ${previous}ms -> ${CHUNK_SECONDS * 1000}ms`,
    );
  }, []);

  const teardown = useCallback(() => {
    clearChunkTimer();
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = null;

    // The AudioContext may already be closed if the page is tearing down, and
    // disconnecting a node in a closed context throws. Teardown must never be
    // the thing that breaks stopping a recording.
    try {
      workletRef.current?.port.close();
      workletRef.current?.disconnect();
    } catch {
      // already torn down
    }
    workletRef.current = null;

    try {
      silentGainRef.current?.disconnect();
    } catch {
      // already torn down
    }
    silentGainRef.current = null;

    pcmRef.current = [];
    inFlightRef.current = false;
    pollInFlightRef.current = false;
  }, [clearChunkTimer]);

  useEffect(() => teardown, [teardown]);

  const sendChunk = useCallback(async () => {
    const id = liveIdRef.current;
    if (!id || inFlightRef.current) return;
    if (pausedRef.current) return;
    if (pcmRef.current.length === 0) return;

    // Take everything buffered so far, then clear. Samples arriving during the
    // upload accumulate for the next slice.
    const pending = pcmRef.current;
    pcmRef.current = [];

    const total = pending.reduce((sum, buf) => sum + buf.length, 0);
    if (total === 0) return;

    const flat = new Float32Array(total);
    let offset = 0;
    for (const buf of pending) {
      flat.set(buf, offset);
      offset += buf.length;
    }

    const bufferedSeconds = flat.length / sampleRateRef.current;
    const sliceStart = sentSecondsRef.current;

    // Trim an over-long buffer to its tail, so a request can never grow past the
    // server's limit no matter how long the cadence was backed off for.
    const maxSamples = Math.floor(MAX_SLICE_SECONDS * sampleRateRef.current);
    const slice =
      flat.length > maxSamples ? flat.subarray(flat.length - maxSamples) : flat;

    const droppedSeconds = (flat.length - slice.length) / sampleRateRef.current;
    const sliceSeconds = slice.length / sampleRateRef.current;
    const startAt = sliceStart + droppedSeconds;
    const audioTotal = recordedSecondsRef.current;

    // Consume the whole buffer whatever happens, so a dropped span is not
    // retried forever and later slices keep correct offsets.
    sentSecondsRef.current = sliceStart + bufferedSeconds;

    if (droppedSeconds > 0) {
      console.info(
        `[live] slice trimmed to ${MAX_SLICE_SECONDS}s, dropped ${droppedSeconds.toFixed(1)}s of backlog`,
      );
    }

    const blob = encodeWav(slice, sampleRateRef.current);
    const form = new FormData();
    form.append("audio", blob, "chunk.wav");
    form.append("offset", String(startAt));
    form.append("audioTotal", String(Math.max(audioTotal, sentSecondsRef.current)));

    inFlightRef.current = true;
    try {
      const response = await fetch(`/api/live/${id}/chunk`, { method: "POST", body: form });
      const payload = await response.json().catch(() => null);

      if (response.ok) {
        // A slice is only ever a preview. If the summary refresh hit a rate
        // limit the captions are still fine, but the account is clearly at its
        // ceiling, so the whole live cadence slows down.
        if (payload?.rateLimited) {
          backOff("summary refresh rate limited");
        } else {
          resetCadence();
        }
        return;
      }

      if (payload?.rateLimited) {
        backOff(`HTTP ${response.status} (${payload.upstreamStatus ?? "?"})`);
      } else {
        console.info(
          `[live] slice rejected, not retrying: ${payload?.error ?? response.status}`,
        );
      }
      // The audio is intentionally dropped rather than re-queued. Re-queueing
      // would grow the buffer on every failure until the slice exceeded the
      // request limit and live mode failed permanently. A short gap in the
      // captions is the better trade, and the authoritative transcript
      // re-transcribes the complete recording afterwards regardless.
    } catch (err) {
      console.info(
        `[live] slice request failed, not retrying: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
    } finally {
      inFlightRef.current = false;
    }
  }, [backOff, resetCadence]);

  /** Resolvable delay that teardown can cut short. */
  const waitFor = useCallback((ms: number) => {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        sleepersRef.current = sleepersRef.current.filter((f) => f !== finish);
        resolve();
      }, ms);
      sleepersRef.current.push(finish);
    });
  }, []);

  /**
   * Sends one slice per cadence until stopped, backing off as needed.
   *
   * A generation counter rather than recursion: a self-referencing
   * useCallback is not valid, and bumping the generation is what makes teardown
   * cancel a loop that is currently waiting on a delay. Any pending sleep is
   * woken immediately so nothing is left running after a stop.
   */
  const runChunkLoop = useCallback(
    async (generation: number) => {
      while (generationRef.current === generation && liveIdRef.current) {
        await waitFor(chunkIntervalRef.current);
        if (generationRef.current !== generation) return;
        if (pausedRef.current) return;
        await sendChunk();
      }
    },
    [sendChunk, waitFor],
  );

  const poll = useCallback(async () => {
    const id = liveIdRef.current;
    if (!id) return;
    // A poll that is still waiting on the server must not be joined by the next
    // interval tick, or requests queue behind each other and the captions
    // arrive later and later.
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;

    try {
      const url = `/api/live/${id}?segments=${seenSegmentsRef.current}&summary=${seenSummaryRef.current}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return;

      const delta = (await response.json()) as LiveDelta;

      if (delta.segments.length > 0) {
        seenSegmentsRef.current += delta.segments.length;
        setCaptions((previous) => [...previous, ...delta.segments]);
      }
      if (delta.summary && delta.summarySeq > seenSummaryRef.current) {
        seenSummaryRef.current = delta.summarySeq;
        setSummarySeq(delta.summarySeq);
        setSummary(delta.summary);
      }
      if (typeof delta.audioSeconds === "number") {
        setAudioSeconds(delta.audioSeconds);
      }
    } catch {
      // A missed poll is harmless; the next one catches up.
    } finally {
      pollInFlightRef.current = false;
    }
  }, []);

  const start = useCallback(
    async (options: {
      stream: MediaStream;
      audioContext: AudioContext;
      title: string;
    }) => {
      setError(null);
      setCaptions([]);
      setSummary(null);
      setSummarySeq(0);
      setPaused(false);
      pausedRef.current = false;
      seenSegmentsRef.current = 0;
      seenSummaryRef.current = 0;
      sentSecondsRef.current = 0;
      recordedSecondsRef.current = 0;
      chunkIntervalRef.current = CHUNK_SECONDS * 1000;

      const created = await fetch("/api/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: options.title }),
      });
      if (!created.ok) {
        const body = await created.json().catch(() => null);
        setError(body?.error ?? "Could not start a live session.");
        return false;
      }
      const { id } = (await created.json()) as { id: string };
      liveIdRef.current = id;
      setLiveId(id);

      sampleRateRef.current = options.audioContext.sampleRate;
      const { audioContext } = options;

      try {
        const blobUrl = URL.createObjectURL(
          new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
        );
        await audioContext.audioWorklet.addModule(blobUrl);
        URL.revokeObjectURL(blobUrl);

        const source = audioContext.createMediaStreamSource(options.stream);
        const tap = new AudioWorkletNode(audioContext, "pcm-tap");
        // A worklet only runs while it is connected, and connecting straight to
        // the speakers would echo the meeting back at everyone. A muted gain node
        // keeps the graph running without producing sound.
        const silent = audioContext.createGain();
        silent.gain.value = 0;

        tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
          pcmRef.current.push(event.data);
        };

        source.connect(tap);
        tap.connect(silent);
        silent.connect(audioContext.destination);

        workletRef.current = tap;
        silentGainRef.current = silent;
      } catch (err) {
        setError(
          `Live captions need AudioWorklet support: ${
            err instanceof Error ? err.message : "unavailable"
          }. The recording will still be saved.`,
        );
      }

      pollTimerRef.current = setInterval(() => void poll(), POLL_MS);
      void runChunkLoop(generationRef.current);
      return true;
    },
    [poll, runChunkLoop],
  );
  /**
   * Tracks how much audio has been recorded, and enforces the live ceiling.
   *
   * Reaching the ceiling stops the live timers and nothing else: the
   * MediaRecorder is untouched, so the recording continues and the full audio is
   * still uploaded and transcribed when it stops. Only the preview goes quiet.
   */
  const tick = useCallback(
    (elapsedSeconds: number) => {
      recordedSecondsRef.current = elapsedSeconds;
      if (pausedRef.current || elapsedSeconds < LIVE_CEILING_SECONDS) return;

      pausedRef.current = true;
      setPaused(true);
      clearChunkTimer();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      console.info(
        `[live] ceiling reached at ${Math.round(elapsedSeconds)}s, live updates paused`,
      );
    },
    [clearChunkTimer],
  );

  /**
   * Stops timers and the audio tap, flushing whatever is buffered. The caller
   * then uploads the full recording and finalises.
   *
   * Nothing here talks to the transcription or summarization paths that produce
   * the authoritative result, so a live failure or an active backoff cannot
   * affect them.
   */
  const stop = useCallback(async () => {
    teardown();
    // No final flush once the ceiling has stopped live updates, so stopping a
    // long meeting does not resurrect the path that was deliberately disabled.
    if (!pausedRef.current) await sendChunk();
  }, [sendChunk, teardown]);

  const reset = useCallback(() => {
    teardown();
    liveIdRef.current = null;
    setLiveId(null);
    setCaptions([]);
    setSummary(null);
    setSummarySeq(0);
    setAudioSeconds(0);
    setError(null);
    setPaused(false);
    pausedRef.current = false;
    seenSegmentsRef.current = 0;
    seenSummaryRef.current = 0;
    sentSecondsRef.current = 0;
    recordedSecondsRef.current = 0;
    chunkIntervalRef.current = CHUNK_SECONDS * 1000;
  }, [teardown]);

  /** Finalises a live session into the normal pipeline. */
  const finalize = useCallback(
    async (input: {
      id: string;
      audioUrl: string;
      filename: string;
      mime: string;
      size: number;
      durationSeconds: number | null;
    }) => {
      const response = await fetch(`/api/live/${input.id}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioUrl: input.audioUrl,
          filename: input.filename,
          mime: input.mime,
          size: input.size,
          duration: input.durationSeconds,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Could not finalise the live session.");
      }
    },
    [],
  );

  return {
    liveId,
    captions,
    summary,
    summarySeq,
    audioSeconds,
    error: error,
    /** True once the live ceiling stopped updates for a long recording. */
    paused,
    start,
    tick,
    stop,
    reset,
    finalize,
    active: liveId !== null,
  };
}
