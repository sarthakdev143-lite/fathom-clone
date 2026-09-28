"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { upload } from "@vercel/blob/client";
import { useLiveSession } from "@/lib/use-live-session";
import { describeProgress, runStage, type StageProgress } from "@/lib/pipeline-client";
import {
  TabAudioError,
  mixAudioSources,
  requestTabAudioStream,
  tabAudioSupported,
  type CaptureMode,
  type MixedCapture,
} from "@/lib/audio-mix";
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
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

type Phase =
  | "idle"
  | "requesting"
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
  /**
   * Which inputs a recording actually contained. Null for uploads, where the
   * question does not apply. Recorded rather than assumed, so a file that
   * claims to be a meeting recording is never described as microphone-only
   * because that was the default when it started.
   */
  sources?: "tab+mic" | "mic" | null;
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

const detectTabAudioSupport = () => tabAudioSupported();

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
  const [stageProgress, setStageProgress] = useState<StageProgress | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("tab");
  const [capturedSources, setCapturedSources] = useState<"tab+mic" | "mic" | null>(null);
  // Mirrors capturedSources for the stop handler, which runs after a state
  // update and would otherwise read a stale value.
  const capturedSourcesRef = useRef<"tab+mic" | "mic" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useLiveSession();
  const [title, setTitle] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [meterActive, setMeterActive] = useState(false);

  const supported = useSyncExternalStore(
    subscribeToNothing,
    detectRecordingSupport,
    serverSnapshot,
  );

  const tabSupported = useSyncExternalStore(
    subscribeToNothing,
    detectTabAudioSupport,
    serverSnapshot,
  );

  // Captions should follow the newest speech without the reader having to
  // scroll. Sticky at the bottom means it only auto-scrolls when already there,
  // so a reader who has scrolled back is not yanked away.
  const captionScrollRef = useRef<HTMLDivElement | null>(null);
  const captionCountRef = useRef(0);
  useEffect(() => {
    const count = live.captions.length;
    if (count === captionCountRef.current) return;
    captionCountRef.current = count;
    const el = captionScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) el.scrollTop = el.scrollHeight;
  }, [live.captions]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mixRef = useRef<MixedCapture | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const releaseStream = useCallback(() => {    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    // The mix owns the tab track and its own AudioContext, and its dispose also
    // closes that context, so it is torn down before the standalone reference.
    mixRef.current?.dispose();
    mixRef.current = null;
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

  const startRecording = useCallback(async (mode: CaptureMode) => {
    setError(null);
    setCaptured(null);
    setMeetingId(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "This browser cannot record audio. Use the upload option below instead.",
      );
      return;
    }

    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
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

    /*
     * Tab capture needs a user gesture, so the picker is opened from the click
     * that started this. If it is cancelled or no audio is shared, the
     * microphone that was already granted is released and nothing is recorded -
     * silently falling back to mic-only would leave the user believing they had
     * captured both sides of the call.
     */
    let tabStream: MediaStream | null = null;
    if (mode === "tab") {
      setPhase("requesting");
      try {
        tabStream = await requestTabAudioStream();
      } catch (err) {
        for (const track of micStream.getTracks()) track.stop();
        setError(
          err instanceof TabAudioError
            ? err.message
            : `Could not capture tab audio: ${
                err instanceof Error ? err.message : "unknown error"
              }`,
        );
        return;
      }
      capturedSourcesRef.current = "tab+mic";      setCapturedSources("tab+mic");
    } else {
      capturedSourcesRef.current = "mic";      setCapturedSources("mic");
    }

    /*
     * In mic mode the raw stream is recorded directly, so solo recording keeps
     * working even if an AudioContext fails to start. In tab mode the two
     * sources must be summed first, and the mixed stream becomes both what is
     * recorded and what the live caption tap listens to, so the captions cover
     * the remote side too.
     */
    let recordingStream: MediaStream;
    let liveSourceStream: MediaStream;

    if (tabStream) {
      const mix = mixAudioSources({ micStream, tabStream });
      mixRef.current = mix;
      recordingStream = mix.stream;
      liveSourceStream = mix.stream;
      mix.onTabTrackEnded(() => {
        // The user stopped sharing. Recording continues on the microphone, but
        // staying silent about it would mean a transcript that looks complete
        // while missing every remote speaker.
        setNotice(
          "Tab sharing stopped, so only your microphone is being recorded from " +
            "here on. Stop and restart if you need the other side back.",
        );
        capturedSourcesRef.current = "mic";        setCapturedSources("mic");
      });
    } else {
      recordingStream = micStream;
      liveSourceStream = micStream;
    }

    streamRef.current = recordingStream;
    const startedAt = performance.now();

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        recordingStream,
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
        // Read the state, not the mode that was requested: if tab sharing
        // stopped part-way through, only the microphone was recorded after that.
        sources: capturedSourcesRef.current,
      });
      setPhase("ready");
    };
    recorder.onerror = () => {
      releaseStream();
      setError("Recording stopped because of a MediaRecorder error.");
      setPhase("idle");
    };

    // Without this, Stop could only end the recording indirectly (by stopping
    // the tracks), and would briefly flash the idle screen before `onstop`.
    recorderRef.current = recorder;
    recorder.start(1000);
    setPhase("recording");

    /*
     * In tab mode the mix already owns an AudioContext, so it is reused rather
     * than a second one being created - two contexts would resample the same
     * stream twice. The meter and the live tap both read the mixed stream, so
     * the captions cover the remote side of the call as well as the room.
     */
    const audioCtx: AudioContext | null = tabStream
      ? mixRef.current?.audioContext ?? null
      : (() => {
          try {
            const created = new AudioContext();
            audioCtxRef.current = created;
            return created;
          } catch {
            setMeterActive(false);
            return null;
          }
        })();

    if (audioCtx) {
      try {
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        audioCtx.createMediaStreamSource(liveSourceStream).connect(analyser);
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
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        // A missing level meter is not worth failing a recording over.
        setMeterActive(false);
      }

      if (liveEnabled) {
        await live.start({
          stream: liveSourceStream,
          audioContext: audioCtx,
          title: title.trim() || "Live meeting",
        });
      }
    }
    setElapsed(0);

    timerRef.current = setInterval(
      () => {
        const seconds = (performance.now() - startedAt) / 1000;
        setElapsed(seconds);
        live.tick(seconds);
      },
      200,
    );
  }, [live, liveEnabled, releaseStream, title]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    // Live mode is torn down first, while the AudioContext is still open:
    // disconnecting a worklet in a closed context throws, which would abort
    // stop() before the recorder is ever stopped and the UI would hang.
    void live.stop();
    releaseStream();
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      recorderRef.current = null;
    } else {
      setPhase("idle");
    }
  }, [live, releaseStream]);

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
    live.reset();
    setCaptured(null);
    setMeetingId(null);
    setTranscript(null);
    setSummary(null);
    setUploadProgress(null);
    setElapsed(0);
    setPhase("idle");
  }, [live, releaseStream]);

  /**
   * Two steps, in this order:
   *   1. Push the audio straight to blob storage from the browser, using a
   *      short-lived client token minted by /api/meetings/blob.
   *   2. Point the server at the resulting URL.
   *
   * The audio never enters a serverless function, so the 4.5 MB request body
   * limit that used to cap recordings at roughly four minutes no longer applies.
   *
   * A live session already has a meeting row, so step 2 finalises that row
   * instead of creating a second one. Either way the meeting ends up in
   * `uploaded`, and the pipeline from there is identical.
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

      const audio = {
        url: result.url,
        filename: file.name,
        mime: contentType,
        size: file.size,
      };

      if (live.active && live.liveId) {
        await live.finalize({
          id: live.liveId,
          audioUrl: audio.url,
          filename: audio.filename,
          mime: audio.mime,
          size: audio.size,
          durationSeconds: captured.durationSeconds,
        });
        setMeetingId(live.liveId);
      } else {
        const response = await fetch("/api/meetings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            source: captured.source,
            duration: captured.durationSeconds,
            audio,
          }),
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          setError(payload?.error ?? `Upload failed (HTTP ${response.status}).`);
          setPhase("ready");
          return;
        }
        setMeetingId(payload?.meeting?.id ?? null);
      }

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
  }, [captured, live, title]);

  /*
   * Both stages are resumable on the server: long audio is transcribed chunk
   * by chunk and long transcripts summarised window by window, across as many
   * requests as it takes. `runStage` keeps calling until the stage is done.
   */
  const transcribe = useCallback(async () => {
    if (!meetingId) return;
    setError(null);
    setStageProgress(null);
    setPhase("transcribing");

    try {
      const payload = await runStage(meetingId, "transcribe", {
        onProgress: setStageProgress,
      });
      setTranscript(payload?.transcript ?? null);
      setPhase("transcribed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed.");
      setPhase("uploaded");
    } finally {
      setStageProgress(null);
    }
  }, [meetingId]);

  const summarize = useCallback(async () => {
    if (!meetingId) return;
    setError(null);
    setStageProgress(null);
    setPhase("summarizing");

    try {
      const payload = await runStage(meetingId, "summarize", {
        onProgress: setStageProgress,
      });
      setSummary(payload?.summary ?? null);
      setPhase("ready-to-view");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Summarization failed.");
      setPhase("transcribed");
    } finally {
      setStageProgress(null);
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
          {describeProgress(stageProgress) && (
            <p className="muted small" aria-live="polite" style={{ marginBottom: 0 }}>
              {describeProgress(stageProgress)}
            </p>
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
              <dd>
                {captured.source === "recording"
                  ? captured.sources === "tab+mic"
                    ? "Tab audio + microphone"
                    : "Microphone only"
                  : "Upload"}
              </dd>
            </div>
          </dl>

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
      ) : phase === "requesting" ? (
        <div className="panel panel-recording">
          <p className="muted" style={{ margin: 0 }}>
            Choose the tab playing your meeting, and tick{" "}
            <strong>&ldquo;Also share tab audio&rdquo;</strong> when the browser
            asks. Recording starts once you confirm.
          </p>
        </div>
      ) : phase === "recording" ? (
        <div className="panel panel-recording">
          <div className="rec-live">
            <span className="dot" aria-hidden="true" />
            Recording
            {capturedSources && (
              <span className="source-badge">
                {capturedSources === "tab+mic"
                  ? "tab audio + microphone"
                  : "microphone only"}
              </span>
            )}
          </div>
          <p className="rec-timer">{formatDuration(elapsed)}</p>
          {notice && (
            <p className="warn" role="status">
              {notice}
            </p>
          )}
          {meterActive && (
            <div className="meter" aria-hidden="true">
              <div
                className="meter-fill"
                style={{ width: `${meterPercent(level)}%` }}
              />
            </div>
          )}

          {live.active && live.paused && (
            <p className="live-paused" role="status">
              Live updates paused for long recordings. Recording is still
              running, and the full transcript and summary are produced when you
              stop.
            </p>
          )}

          {live.active && !live.paused && (
            <div className="live-grid">
              <section className="live-panel" aria-label="Live captions">
                <h3>
                  Live captions
                  <span className="muted small">
                    {" "}
                    {live.captions.length > 0
                      ? `${formatDuration(live.audioSeconds)} transcribed`
                      : "listening"}
                  </span>
                </h3>
                {live.captions.length === 0 ? (
                  <p className="muted small" style={{ margin: 0 }}>
                    Waiting for speech&hellip;
                  </p>
                ) : (
                  <div className="captions" ref={captionScrollRef}>
                    {live.captions.map((caption) => (
                      <p key={`${caption.start}-${caption.end}`}>
                        <code>{formatDuration(caption.start)}</code> {caption.text}
                      </p>
                    ))}
                  </div>
                )}
              </section>

              <section className="live-panel" aria-label="Live summary">
                <h3>
                  Live summary
                  <span className="live-badge">provisional</span>
                </h3>
                {!live.summary ? (
                  <p className="muted small" style={{ margin: 0 }}>
                    First update after about 30 seconds of speech.
                  </p>
                ) : (
                  <div key={live.summarySeq} className="live-summary-body">
                    <p className="tldr" style={{ marginBottom: "0.6rem" }}>
                      {live.summary.tldr}
                    </p>
                    {live.summary.topics.length > 0 && (
                      <ul className="chips" style={{ marginBottom: "0.6rem" }}>
                        {live.summary.topics.map((topic) => (
                          <li key={topic}>{topic}</li>
                        ))}
                      </ul>
                    )}
                    {live.summary.action_items.length > 0 && (
                      <ul className="tasks">
                        {live.summary.action_items.map((item) => (
                          <li key={item.task}>
                            <span>{item.task}</span>
                            <span className="muted small">
                              {item.owner ?? "unassigned"}
                              {item.due ? ` · ${item.due}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                </section>
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
              onClick={() => startRecording(captureMode)}
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

          <fieldset className="capture">
            <legend>What to record</legend>

            <label className="capture-option">
              <input
                type="radio"
                name="capture-mode"
                value="tab"
                checked={captureMode === "tab"}
                disabled={!tabSupported}
                onChange={() => setCaptureMode("tab")}
              />
              <span>
                <strong>Record this tab&apos;s meeting audio</strong>
                <span className="muted small">
                  Captures the meeting playing in a browser tab and adds your
                  microphone, so both sides end up in the recording. Needs Chrome
                  or Edge, and you must tick &ldquo;Also share tab audio&rdquo;
                  when the picker appears.
                </span>
              </span>
            </label>

            <label className="capture-option">
              <input
                type="radio"
                name="capture-mode"
                value="mic"
                checked={captureMode === "mic"}
                onChange={() => setCaptureMode("mic")}
              />
              <span>
                <strong>Record microphone only</strong>
                <span className="muted small">
                  Just your own voice, for solo notes and dictation. A
                  microphone cannot hear the other side of a call.
                </span>
              </span>
            </label>

            {!tabSupported && (
              <p className="muted small" style={{ margin: "0.5rem 0 0" }}>
                This browser cannot share tab audio, so the microphone option is
                the only one available.
              </p>
            )}
          </fieldset>

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

          <label className="check">
            <input
              type="checkbox"
              checked={liveEnabled}
              onChange={(event) => setLiveEnabled(event.target.checked)}
            />
            <span>
              Show live captions and a running summary while recording
              <span className="muted small">
                {" "}
                Extra transcription calls while the meeting runs. The final
                summary is still produced from the complete recording.
              </span>
            </span>
          </label>

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
