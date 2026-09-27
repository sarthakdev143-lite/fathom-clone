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

/** How much audio to accumulate before sending a slice. */
const CHUNK_SECONDS = 6;
/** How often to ask the server for new captions and a new summary. */
const POLL_MS = 2000;

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

  const workletRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(48000);
  /** Audio already sent, so each slice continues the timeline. */
  const sentSecondsRef = useRef(0);
  /** Total recorded, which is ahead of what has been transcribed. */
  const recordedSecondsRef = useRef(0);
  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const liveIdRef = useRef<string | null>(null);
  const seenSegmentsRef = useRef(0);
  const seenSummaryRef = useRef(0);

  const teardown = useCallback(() => {
    if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    chunkTimerRef.current = null;
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
  }, []);

  useEffect(() => teardown, [teardown]);

  const sendChunk = useCallback(async () => {
    const id = liveIdRef.current;
    if (!id || inFlightRef.current) return;
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

    const sliceSeconds = flat.length / sampleRateRef.current;
    const startAt = sentSecondsRef.current;
    const audioTotal = recordedSecondsRef.current;

    const blob = encodeWav(flat, sampleRateRef.current);
    const form = new FormData();
    form.append("audio", blob, "chunk.wav");
    form.append("offset", String(startAt));
    form.append("audioTotal", String(Math.max(audioTotal, startAt + sliceSeconds)));

    inFlightRef.current = true;
    try {
      const response = await fetch(`/api/live/${id}/chunk`, { method: "POST", body: form });
      if (response.ok) {
        // Advance past this slice regardless of what came back, so a slice that
        // fails is skipped rather than resent forever.
        sentSecondsRef.current = startAt + sliceSeconds;
      } else {
        pcmRef.current.unshift(...pending);
      }
    } catch {
      pcmRef.current.unshift(...pending);
    } finally {
      inFlightRef.current = false;
    }
  }, []);

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
      seenSegmentsRef.current = 0;
      seenSummaryRef.current = 0;
      sentSecondsRef.current = 0;
      recordedSecondsRef.current = 0;

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

      chunkTimerRef.current = setInterval(() => void sendChunk(), CHUNK_SECONDS * 1000);
      pollTimerRef.current = setInterval(() => void poll(), POLL_MS);
      return true;
    },
    [poll, sendChunk],
  );

  /** Tracks wall-clock audio so the server knows how far along the meeting is. */
  const tick = useCallback((elapsedSeconds: number) => {
    recordedSecondsRef.current = elapsedSeconds;
  }, []);

  /**
   * Stops timers and the audio tap, flushing whatever is buffered. The caller
   * then uploads the full recording and finalises.
   */
  const stop = useCallback(async () => {
    teardown();
    await sendChunk();
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
    seenSegmentsRef.current = 0;
    seenSummaryRef.current = 0;
    sentSecondsRef.current = 0;
    recordedSecondsRef.current = 0;
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
    start,
    tick,
    stop,
    reset,
    finalize,
    active: liveId !== null,
  };
}
