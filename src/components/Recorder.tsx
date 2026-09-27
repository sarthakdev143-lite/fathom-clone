"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Step 1: audio capture.
 *
 * Two ways to get audio in, both landing on the same `File`:
 *   1. Record from the microphone with MediaRecorder.
 *   2. Pick an existing audio/video file (the fallback, and the only option on a
 *      browser or machine where mic access is blocked).
 *
 * The bytes are handed to the server on submit and are not retained afterwards.
 */

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/mpeg",
];

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type Phase =
  | "idle"
  | "recording"
  | "ready"
  | "uploading"
  | "uploaded"
  | "transcribing"
  | "transcribed";

interface CapturedFile {
  file: File;
  source: "recording" | "upload";
  durationSeconds: number | null;
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
  );
}

function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0].trim();
  if (base === "audio/webm") return "webm";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/mpeg") return "mp3";
  return "webm";
}

/** Reads duration out of the file itself so uploaded files are labelled too. */
async function probeDuration(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const audio = document.createElement("audio");
      const done = (value: number | null) => {
        audio.removeAttribute("src");
        URL.revokeObjectURL(url);
        resolve(value);
      };
      audio.preload = "metadata";
      audio.onloadedmetadata = () =>
        done(
          Number.isFinite(audio.duration) && audio.duration > 0
            ? Math.round(audio.duration * 100) / 100
            : null,
        );
      audio.onerror = () => done(null);
      audio.src = url;
    });
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Maps a 0..1 signal peak onto a bar width. The gain is generous because a
 * quiet room produces small peaks, and the floor guarantees that any signal at
 * all still moves the bar, so a live mic never looks like a dead one.
 */
function meterPercent(level: number): number {
  if (level <= 0.001) return 0;
  return Math.min(100, Math.max(4, level * 220));
}

export default function Recorder() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<CapturedFile | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{
    characters: number;
    segments: number;
    language: string | null;
    duration: number | null;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [meterActive, setMeterActive] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = null;
    setLevel(0);
    setMeterActive(false);
  }, []);

  useEffect(() => {
    setSupported(
      typeof navigator !== "undefined" &&
        typeof MediaRecorder !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia),
    );
    return releaseStream;
  }, [releaseStream]);

  const startRecording = useCallback(async () => {
    setError(null);
    setCaptured(null);
    setMeetingId(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "This browser cannot record audio. Use the upload option below instead.",
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it in your browser, or use the upload option below."
          : name === "NotFoundError"
            ? "No microphone was found on this device. Use the upload option below."
            : `Could not open the microphone: ${
                err instanceof Error ? err.message : "unknown error"
              }`,
      );
      return;
    }

    streamRef.current = stream;
    const startedAt = performance.now();

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
    } catch (err) {
      releaseStream();
      setError(
        `MediaRecorder rejected the audio format: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      const seconds = (performance.now() - startedAt) / 1000;
      const name = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionFor(type)}`;
      setCaptured({
        file: new File([blob], name, { type }),
        source: "recording",
        durationSeconds: Math.round(seconds * 100) / 100,
      });
      setPhase("ready");
    };
    recorder.onerror = () => {
      releaseStream();
      setError("Recording stopped because of a MediaRecorder error.");
      setPhase("idle");
    };

    recorder.start(1000);
    setPhase("recording");
    setElapsed(0);

    timerRef.current = setInterval(
      () => setElapsed((performance.now() - startedAt) / 1000),
      200,
    );

    try {
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      setMeterActive(true);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
        }
        setLevel(peak);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);    } catch {
      // A missing level meter is not worth failing a recording over.
      setMeterActive(false);
    }
  }, [releaseStream]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    releaseStream();
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      recorderRef.current = null;
    } else {
      setPhase("idle");
    }
  }, [releaseStream]);

  const onPickFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const picked = event.target.files?.[0];
      // Allow re-picking the same file after a discard.
      event.target.value = "";
      if (!picked) return;

      setError(null);
      if (picked.size > MAX_UPLOAD_BYTES) {
        setError(
          `"${picked.name}" is ${formatBytes(picked.size)}, over the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`,
        );
        return;
      }
      if (picked.size === 0) {
        setError(`"${picked.name}" is empty.`);
        return;
      }

      setCaptured({
        file: picked,
        source: "upload",
        durationSeconds: await probeDuration(picked),
      });
      setPhase("ready");
    },
    [],
  );

  const discard = useCallback(() => {
    releaseStream();
    setCaptured(null);
    setMeetingId(null);
    setTranscript(null);
    setElapsed(0);
    setPhase("idle");
  }, [releaseStream]);

  const transcribe = useCallback(async () => {
    if (!meetingId) return;
    setError(null);
    setPhase("transcribing");

    try {
      const response = await fetch(`/api/meetings/${meetingId}/transcribe`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(payload?.error ?? `Transcription failed (HTTP ${response.status}).`);
        setPhase("uploaded");
        return;
      }
      setTranscript(payload?.transcript ?? null);
      setPhase("transcribed");
    } catch {
      setError("Could not reach the transcription service. Retry in a moment.");
      setPhase("uploaded");
    }
  }, [meetingId]);

  const submit = useCallback(async () => {
    if (!captured) return;
    setError(null);
    setPhase("uploading");

    const body = new FormData();
    body.append("audio", captured.file);
    body.append("source", captured.source);
    body.append(
      "duration",
      captured.durationSeconds === null ? "" : String(captured.durationSeconds),
    );
    body.append("title", title);

    try {
      const response = await fetch("/api/meetings", { method: "POST", body });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(payload?.error ?? `Upload failed (HTTP ${response.status}).`);
        setPhase("ready");
        return;
      }
      setMeetingId(payload?.meeting?.id ?? null);
      setPhase("uploaded");
    } catch {
      setError("Could not reach the server. Check your connection and retry.");
      setPhase("ready");
    }
  }, [captured, title]);

  return (
    <div className="recorder">
      {phase === "uploaded" ||
      phase === "transcribing" ||
      phase === "transcribed" ? (
        <div className="panel panel-ok">
          {phase === "transcribed" ? (
            <>
              <h2>Transcript ready</h2>
              <dl className="meta">
                <div>
                  <dt>Language</dt>
                  <dd>{transcript?.language ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>Length</dt>
                  <dd>{transcript?.characters.toLocaleString()} characters</dd>
                </div>
                <div>
                  <dt>Segments</dt>
                  <dd>{transcript?.segments ?? 0}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>
                    {transcript?.duration
                      ? formatDuration(transcript.duration)
                      : "unknown"}
                  </dd>
                </div>
              </dl>
              <div className="row">
                <button type="button" className="btn" onClick={discard}>
                  Start another meeting
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Audio captured</h2>
              <p className="muted">
                Meeting <code>{meetingId}</code> is stored. Transcribe it to get
                the text.
              </p>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={phase === "transcribing"}
                  onClick={transcribe}
                >
                  {phase === "transcribing" ? "Transcribing…" : "Transcribe audio"}
                </button>
                <button type="button" className="btn" onClick={discard}>
                  Record another
                </button>
              </div>
            </>
          )}
        </div>
      ) : captured ? (
        <div className="panel">
          <h2>Ready to upload</h2>
          <dl className="meta">
            <div>
              <dt>File</dt>
              <dd title={captured.file.name}>{captured.file.name}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{captured.file.type || "unknown"}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(captured.file.size)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {captured.durationSeconds === null
                  ? "unknown"
                  : formatDuration(captured.durationSeconds)}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{captured.source === "recording" ? "Microphone" : "Upload"}</dd>
            </div>
          </dl>

          <label className="field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              placeholder="Untitled meeting"
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={phase === "uploading"}
              onClick={submit}
            >
              {phase === "uploading" ? "Uploading…" : "Upload meeting"}
            </button>
            <button type="button" className="btn" onClick={discard}>
              Discard
            </button>
          </div>
        </div>
      ) : phase === "recording" ? (
        <div className="panel panel-recording">
          <div className="rec-live">
            <span className="dot" aria-hidden="true" />
            Recording
          </div>
          <p className="rec-timer">{formatDuration(elapsed)}</p>
          {meterActive && (
            <div className="meter" aria-hidden="true">
              <div
                className="meter-fill"
                style={{ width: `${meterPercent(level)}%` }}
              />
            </div>
          )}
          <button type="button" className="btn btn-danger" onClick={stopRecording}>
            Stop recording
          </button>
        </div>
      ) : (
        <div className="panel">
          <h2>Capture audio</h2>
          {supported === false && (
            <p className="muted">
              This browser has no MediaRecorder support, so recording is
              unavailable. Uploading a file still works.
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={supported === false}
              onClick={startRecording}
            >
              Start recording
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload a file
            </button>
          </div>
          <p className="muted small">
            Upload accepts anything your browser can play as audio or video, so
            phone voice memos work too.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/*"
            onChange={onPickFile}
            hidden
          />
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
