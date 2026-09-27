"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { upload } from "@vercel/blob/client";
import type { MeetingSummary } from "@/lib/summary";

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

/** Matches `MAX_AUDIO_BYTES` in /api/meetings/blob. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Groq's transcription endpoint rejects audio over 25 MB. Uploading still works
 * above that — the blob store does not care — but the transcription step will
 * fail, so the user is warned rather than stopped.
 */
const TRANSCRIPTION_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

type Phase =
  | "idle"
  | "recording"
  | "ready"
  | "uploading"
  | "uploaded"
  | "transcribing"
  | "transcribed"
  | "summarizing"
  | "ready-to-view";

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

function detectRecordingSupport(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * The recording capability is null on the server, because there is no
 * `navigator` there. `useSyncExternalStore` is the supported way to read a value
 * that legitimately differs between server and client: it reports `null` while
 * rendering on the server and the real answer on the client, without a
 * hydration mismatch and without setting state inside an effect.
 */
const subscribeToNothing = () => () => {};
const serverSnapshot = () => null;

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

/**
 * Above this size the blob client switches to a multipart upload, splitting the
 * file into parts sent in parallel. Worth doing well before the old 4.5 MB
 * function limit: a single 100 MB PUT is slow and fails wholesale, whereas
 * multipart retries individual parts.
 */
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;

/**
 * `audio/webm;codecs=opus` and friends carry codec parameters. The blob
 * allowlist is matched against the declared content type, and the pathname
 * extension is inferred from it, so the parameters are stripped first.
 */
function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase() || "application/octet-stream";
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
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [meterActive, setMeterActive] = useState(false);

  const supported = useSyncExternalStore(
    subscribeToNothing,
    detectRecordingSupport,
    serverSnapshot,
  );

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

  useEffect(() => releaseStream, [releaseStream]);

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
    setSummary(null);
    setUploadProgress(null);
    setElapsed(0);
    setPhase("idle");
  }, [releaseStream]);

  /**
   * Two steps, in this order:
   *   1. Push the audio straight to blob storage from the browser, using a
   *      short-lived client token minted by /api/meetings/blob.
   *   2. Tell the server the meeting exists, passing only the resulting URL.
   *
   * The audio never enters a serverless function, so the 4.5 MB request body
   * limit that used to cap recordings at roughly four minutes no longer applies.
   */
  const submit = useCallback(async () => {
    if (!captured) return;
    setError(null);
    setPhase("uploading");
    setUploadProgress(0);

    const { file } = captured;
    const contentType = baseMimeType(file.type);

    try {
      const result = await upload(`audio/${file.name}`, file, {
        access: "public",
        handleUploadUrl: "/api/meetings/blob",
        contentType,
        multipart: file.size > MULTIPART_THRESHOLD_BYTES,
        onUploadProgress: ({ percentage }) => {
          setUploadProgress(Math.round(percentage));
        },
      });

      setUploadProgress(null);

      const response = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          source: captured.source,
          duration: captured.durationSeconds,
          audio: {
            url: result.url,
            filename: file.name,
            mime: contentType,
            size: file.size,
          },
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(payload?.error ?? `Upload failed (HTTP ${response.status}).`);
        setPhase("ready");
        return;
      }
      setMeetingId(payload?.meeting?.id ?? null);
      setPhase("uploaded");
    } catch (err) {
      setUploadProgress(null);
      setError(
        err instanceof Error
          ? `Upload failed: ${err.message}`
          : "Upload failed for an unknown reason.",
      );
      setPhase("ready");
    }
  }, [captured, title]);

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

  const summarize = useCallback(async () => {
    if (!meetingId) return;
    setError(null);
    setPhase("summarizing");

    try {
      const response = await fetch(`/api/meetings/${meetingId}/summarize`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(payload?.error ?? `Summarization failed (HTTP ${response.status}).`);
        setPhase("transcribed");
        return;
      }
      setSummary(payload?.summary ?? null);
      setPhase("ready-to-view");
    } catch {
      setError("Could not reach the summarizer. Retry in a moment.");
      setPhase("transcribed");
    }
  }, [meetingId]);

  return (
    <div className="recorder">
      {phase === "ready-to-view" && summary ? (
        <div className="panel panel-ok">
          <h2>Summary ready</h2>
          <p className="tldr">{summary.tldr}</p>

          {summary.topics.length > 0 && (
            <div className="block">
              <h3>Topics</h3>
              <ul className="chips">
                {summary.topics.map((topic) => (
                  <li key={topic}>{topic}</li>
                ))}
              </ul>
            </div>
          )}

          {summary.decisions.length > 0 && (
            <div className="block">
              <h3>Decisions</h3>
              <ul>
                {summary.decisions.map((decision) => (
                  <li key={decision}>{decision}</li>
                ))}
              </ul>
            </div>
          )}

          {summary.action_items.length > 0 && (
            <div className="block">
              <h3>Action items</h3>
              <ul className="tasks">
                {summary.action_items.map((item) => (
                  <li key={item.task}>
                    <span>{item.task}</span>
                    <span className="muted small">
                      {item.owner ?? "unassigned"}
                      {item.due ? ` · ${item.due}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.key_moments.length > 0 && (
            <div className="block">
              <h3>Key moments</h3>
              <ul className="moments">
                {summary.key_moments.map((moment) => (
                  <li key={moment.timestamp}>
                    <code>{formatDuration(moment.timestamp)}</code>
                    <span>{moment.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="row">
            <button type="button" className="btn" onClick={discard}>
              Start another meeting
            </button>
          </div>
        </div>
      ) : phase === "uploaded" ||
        phase === "transcribing" ||
        phase === "transcribed" ||
        phase === "summarizing" ? (
        <div className="panel panel-ok">
          {phase === "transcribed" || phase === "summarizing" ? (
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
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={phase === "summarizing"}
                  onClick={summarize}
                >
                  {phase === "summarizing" ? "Summarizing…" : "Summarize"}
                </button>
                <button type="button" className="btn" onClick={discard}>
                  Record another
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

          {captured.file.size > TRANSCRIPTION_SIZE_LIMIT_BYTES && (
            <p className="warn" role="status">
              This is {formatBytes(captured.file.size)}, over Groq&apos;s 25 MB
              transcription limit. It will upload, but transcription will fail.
            </p>
          )}

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

          {uploadProgress !== null && (
            <div className="progress" aria-live="polite">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${uploadProgress}%` }} />
              </div>
              <span className="muted small">{uploadProgress}%</span>
            </div>
          )}
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

          <details className="stub">
            <summary>Import from a meeting link</summary>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Joining Zoom, Google Meet or Teams with a bot is explicitly out of
              scope for this build, so this does nothing. See{" "}
              <code>src/lib/bot-join.ts</code> for what it would actually take.
            </p>
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button
                type="button"
                className="btn"
                disabled
                title="Not implemented"
                onClick={() => undefined}
              >
                Paste a meeting link
              </button>
            </div>
          </details>

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
