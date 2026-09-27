import Link from "next/link";
import SetupNotice from "@/components/SetupNotice";
import { isDbConfigured } from "@/lib/config";
import { listMeetings } from "@/lib/meetings";
import type { Meeting, MeetingStatus } from "@/lib/types";

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

function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return "--";
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function parseSummary(meeting: Meeting) {
  if (!meeting.summary_json) return null;
  try {
    return JSON.parse(meeting.summary_json) as {
      tldr?: string;
      topics?: string[];
      action_items?: { task: string; owner: string | null; due: string | null }[];
    };
  } catch {
    return null;
  }
}

export default async function Dashboard() {
  if (!isDbConfigured) {
    return (
      <main>
        <h1>Meetings</h1>
        <SetupNotice />
      </main>
    );
  }

  const meetings = await listMeetings();
  const readyCount = meetings.filter((m) => m.status === "ready").length;
  const openActions = meetings.reduce(
    (total, meeting) => total + (parseSummary(meeting)?.action_items?.length ?? 0),
    0,
  );

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Meetings</h1>
          <p className="lede">
            {meetings.length === 0
              ? "Nothing captured yet."
              : `${meetings.length} captured · ${readyCount} summarised · ${openActions} action items`}
          </p>
        </div>
        <Link className="btn btn-primary" href="/record">
          Record a meeting
        </Link>
      </div>

      {meetings.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            No meetings yet.{" "}
            <Link href="/record">Record one</Link> or upload an audio file to
            get started.
          </p>
        </div>
      ) : (
        <ul className="meeting-list">
          {meetings.map((meeting) => {
            const summary = parseSummary(meeting);
            return (
              <li key={meeting.id}>
                <Link href={`/meetings/${meeting.id}`} className="meeting-card">
                  <div className="meeting-card-head">
                    <h2>{meeting.title}</h2>
                    <span className={`pill pill-${meeting.status}`}>
                      {STATUS_LABELS[meeting.status]}
                    </span>
                  </div>
                  <p className="muted small meeting-card-meta">
                    {formatDate(meeting.created_at)} ·{" "}
                    {formatDuration(meeting.duration_seconds)} ·{" "}
                    {meeting.source}
                    {meeting.audio_bytes
                      ? ` · ${(meeting.audio_bytes / 1024 / 1024).toFixed(1)} MB`
                      : ""}
                  </p>
                  {summary?.tldr ? (
                    <p className="meeting-card-tldr">{summary.tldr}</p>
                  ) : meeting.status === "failed" && meeting.status_error ? (
                    <p className="meeting-card-error">{meeting.status_error}</p>
                  ) : (
                    <p className="muted small">No summary yet.</p>
                  )}
                  {summary?.topics && summary.topics.length > 0 && (
                    <ul className="chips" style={{ marginTop: "0.75rem" }}>
                      {summary.topics.slice(0, 4).map((topic) => (
                        <li key={topic}>{topic}</li>
                      ))}
                    </ul>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
