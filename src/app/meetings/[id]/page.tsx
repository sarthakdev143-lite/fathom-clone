import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AudioPlayer,
  KeyMomentList,
  PlaybackProvider,
  TranscriptView,
} from "@/components/MeetingPlayback";
import MeetingChat from "@/components/MeetingChat";
import PipelineActions from "@/components/PipelineActions";
import SetupNotice from "@/components/SetupNotice";
import TranscriptExport from "@/components/TranscriptExport";
import { isTrustedBlobUrl } from "@/lib/blob-url";
import { isDbConfigured } from "@/lib/config";
import { getMeeting, getSegments } from "@/lib/meetings";
import { sweepQuietly } from "@/lib/sweep";
import type { MeetingSummary } from "@/lib/summary";
import type { MeetingStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<MeetingStatus, string> = {
  live: "Recording",
  uploaded: "Awaiting transcription",
  transcribing: "Transcribing",
  transcribed: "Awaiting summary",
  summarizing: "Summarizing",
  ready: "Ready",
  failed: "Failed",
};

/**
 * A live session whose row has not moved for a while means the browser went away
 * mid-recording. Without this the dashboard would show it as still recording
 * forever, which is worse than admitting the tab closed.
 */
const LIVE_STALE_SECONDS = 120;

function isStaleLive(status: MeetingStatus, updatedAt: string): boolean {
  if (status !== "live") return false;
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(updated)) return true;
  return (Date.now() - updated) / 1000 > LIVE_STALE_SECONDS;
}

function isLeaseActive(leaseUntil: number | null | undefined): boolean {
  return typeof leaseUntil === "number" && leaseUntil > Date.now();
}

function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return "unknown";
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

function parseSummary(raw: string | null): MeetingSummary | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MeetingSummary;
  } catch {
    return null;
  }
}

/**
 * Reads ?t=SECONDS. Anything that is not a finite, non-negative number is
 * ignored rather than rejected, since a mangled share link should still open
 * the meeting. Values past the end are clamped to the recording's length.
 */
function parseStartTime(
  raw: string | string[] | undefined,
  durationSeconds: number | null,
): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (durationSeconds !== null && Number.isFinite(durationSeconds)) {
    return Math.min(seconds, Math.max(0, durationSeconds - 0.5));
  }
  return seconds;
}

/**
 * Explains, in one sentence, why playback or seeking is limited - or returns
 * null when everything works. Kept here rather than in the client component
 * because the reason depends on how the meeting was created, which only the
 * server knows.
 */
function playbackNote(input: {
  hasAudio: boolean;
  hasTimings: boolean;
  source: string;
  hadLegacyAudio: boolean;
}): string | null {
  const jumpsToText = input.hasTimings
    ? " Timestamps still jump to the matching line in the transcript."
    : "";

  if (!input.hasAudio) {
    if (input.source === "seed") {
      return `This is a seeded demo meeting generated from a script, so there is no recording to play.${jumpsToText}`;
    }
    if (input.hadLegacyAudio) {
      return `This meeting was recorded before audio playback was added, so its recording cannot be played here.${jumpsToText}`;
    }
    return `No recording is stored for this meeting.${jumpsToText}`;
  }

  if (!input.hasTimings) {
    return (
      "This transcript came from the fallback provider, which does not return " +
      "timestamps, so lines cannot be jumped to. Use the player's scrubber to move around."
    );
  }

  return null;
}

export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  if (!isDbConfigured) {
    return (
      <main>
        <p className="muted small">
          <Link href="/">&larr; All meetings</Link>
        </p>
        <h1>Meeting</h1>
        <SetupNotice />
      </main>
    );
  }

  await sweepQuietly();
  const meeting = await getMeeting(id);

  if (!meeting) notFound();

  const summary = parseSummary(meeting.summary_json);
  const segments = await getSegments(id);

  // Re-checked at render time, not just when stored: the value ends up in an
  // <audio src>, and a URL that is not a Vercel Blob URL has no business there.
  const audioUrl = isTrustedBlobUrl(meeting.audio_url) ? meeting.audio_url : null;
  const hasTimings = segments.length > 0;
  const initialTime = parseStartTime(query.t, meeting.duration_seconds);
  const note = playbackNote({
    hasAudio: audioUrl !== null,
    hasTimings,
    source: meeting.source,
    hadLegacyAudio: meeting.audio_url == null && Boolean(meeting.audio_filename),
  });

  return (
    <main>
      <p className="muted small">
        <Link href="/">&larr; All meetings</Link>
      </p>

      <div className="page-head">
        <div>
          <h1>{meeting.title}</h1>
          <p className="lede">
            {formatDate(meeting.created_at)} ·{" "}
            {formatDuration(meeting.duration_seconds)} ·{" "}
            {meeting.source === "recording" ? "microphone" : meeting.source}
            {meeting.audio_bytes
              ? ` · ${(meeting.audio_bytes / 1024 / 1024).toFixed(1)} MB`
              : ""}
            {meeting.transcript_language
              ? ` · ${meeting.transcript_language}`
              : ""}
          </p>
        </div>
        <span
          className={`pill pill-${meeting.status}`}
          title={
            isStaleLive(meeting.status, meeting.updated_at)
              ? "This recording has not been updated for a few minutes, so the tab that was capturing it has probably closed."
              : undefined
          }
        >
          {isStaleLive(meeting.status, meeting.updated_at)
            ? "Interrupted"
            : STATUS_LABELS[meeting.status]}
        </span>
      </div>

      {meeting.status === "failed" && meeting.status_error && (
        <p className="error" role="alert">
          {meeting.status_error}
        </p>
      )}

      <PipelineActions
        meetingId={meeting.id}
        status={meeting.status}
        canTranscribe={
          audioUrl !== null || (meeting.audio_url == null && Boolean(meeting.audio_filename))
        }
        hasTranscript={Boolean(meeting.transcript && meeting.transcript.trim())}
        processingElsewhere={isLeaseActive(meeting.lease_until)}
      />

      {meeting.transcript_provider === "gemini" && (
        <p className="fallback-note" role="status">
          Transcribed by the Gemini fallback
          {meeting.transcript_fallback_reason
            ? ` after Groq failed: ${meeting.transcript_fallback_reason}`
            : "."}
        </p>
      )}

      <PlaybackProvider
        meetingId={meeting.id}
        segments={segments}
        hasTimings={hasTimings}
        canPlay={audioUrl !== null}
        initialTime={initialTime}
      >
      <AudioPlayer audioUrl={audioUrl} note={note} />

      {summary ? (
        <section className="card" style={{ marginBottom: "1.5rem" }}>
          <h2 className="section-title">
            Summary
            {meeting.transcript_sampled === 1 && (
              <span
                className="badge-note"
                title="This meeting's transcript was too long to send in one piece, so the summary was built from an evenly spaced sample of the whole conversation. Earlier and later moments are represented, but some sentences between them were not read, so a detail may be missing."
              >
                Based on a sampled transcript
              </span>
            )}
          </h2>
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
              <KeyMomentList moments={summary.key_moments} />
            </div>
          )}
        </section>
      ) : (
        <p className="muted" style={{ marginBottom: "1.5rem" }}>
          No summary yet.
        </p>
      )}

      {meeting.transcript && (
        <section className="card">
          <h2 className="section-title">
            Transcript
            {segments.length > 0 && (
              <span className="muted small" style={{ fontWeight: 400 }}>
                {" "}
                · {segments.length} segments
              </span>
            )}{" "}
            <TranscriptExport
              title={meeting.title}
              date={formatDate(meeting.created_at)}
              language={meeting.transcript_language}
              tldr={summary?.tldr ?? null}
              segments={segments}
              plainText={meeting.transcript}
              hasTimings={hasTimings}
            />
          </h2>
          <TranscriptView fallbackText={meeting.transcript} />
        </section>
      )}

      <MeetingChat
        meetingId={meeting.id}
        canAsk={Boolean(meeting.transcript && meeting.transcript.trim())}
      />
      </PlaybackProvider>
    </main>
  );
}
