import Link from "next/link";
import { notFound } from "next/navigation";
import SetupNotice from "@/components/SetupNotice";
import { isDbConfigured } from "@/lib/config";
import { getMeeting, getSegments } from "@/lib/meetings";
import type { MeetingSummary } from "@/lib/summary";
import type { MeetingStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<MeetingStatus, string> = {
  uploaded: "Awaiting transcription",
  transcribing: "Transcribing",
  transcribed: "Awaiting summary",
  summarizing: "Summarizing",
  ready: "Ready",
  failed: "Failed",
};

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

export default async function MeetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

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

  const meeting = await getMeeting(id);

  if (!meeting) notFound();

  const summary = parseSummary(meeting.summary_json);
  const segments = await getSegments(id);

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
        <span className={`pill pill-${meeting.status}`}>
          {STATUS_LABELS[meeting.status]}
        </span>
      </div>

      {meeting.status === "failed" && meeting.status_error && (
        <p className="error" role="alert">
          {meeting.status_error}
        </p>
      )}

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
            )}
          </h2>
          {segments.length > 0 ? (
            <ol className="transcript">
              {segments.map((segment) => (
                <li key={`${segment.start}-${segment.end}`}>
                  <code className="transcript-time">
                    {formatDuration(segment.start)}
                  </code>
                  <span>{segment.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p style={{ margin: 0 }}>{meeting.transcript}</p>
          )}
        </section>
      )}
    </main>
  );
}
