"use client";

import Link from "next/link";
import { useState } from "react";
import type { MeetingCitation } from "@/lib/qa";

/**
 * "Ask about this meeting". Each answer is grounded in the transcript lines
 * the server retrieved for the question, and every citation links to the
 * moment it came from - the same ?t= mechanism the key moments use, so it
 * works with or without a recording.
 */

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  citations?: MeetingCitation[];
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function MeetingChat(props: { meetingId: string; canAsk: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!props.canAsk) return null;

  const ask = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setMessages((previous) => [...previous, { role: "user", text: trimmed }]);
    setDraft("");

    try {
      const response = await fetch(`/api/meetings/${props.meetingId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error ?? `Could not answer (HTTP ${response.status}).`);
      }
      setMessages((previous) => [
        ...previous,
        { role: "assistant", text: payload.answer, citations: payload.citations ?? [] },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" style={{ marginBottom: "1.5rem" }}>
      <h2 className="section-title">Ask about this meeting</h2>

      {messages.length === 0 && (
        <p className="muted small" style={{ marginTop: 0 }}>
          Answers come only from this meeting&apos;s transcript and summary, with
          links to the exact moments.
        </p>
      )}

      {messages.map((message, index) => (
        <div key={index} className={message.role === "user" ? "chat-q" : "chat-a"}>
          <p style={{ margin: 0 }}>{message.text}</p>
          {message.citations && message.citations.length > 0 && (
            <p className="muted small" style={{ margin: "0.4rem 0 0" }}>
              {message.citations.map((citation) => (
                <Link
                  key={citation.timestamp}
                  href={`?t=${citation.timestamp}`}
                  scroll={false}
                  title={citation.quote}
                  style={{ marginRight: "0.75rem" }}
                >
                  <code>{formatClock(citation.timestamp)}</code>
                </Link>
              ))}
            </p>
          )}
        </div>
      ))}

      {busy && (
        <p className="muted small" aria-live="polite">
          Reading the transcript…
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <form
        className="row"
        style={{ marginBottom: 0 }}
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <input
          type="text"
          value={draft}
          maxLength={500}
          placeholder="e.g. When does the synthetic test ship, and who owns it?"
          aria-label="Ask a question about this meeting"
          onChange={(event) => setDraft(event.target.value)}
          style={{ flex: 1 }}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>
          Ask
        </button>
      </form>
    </section>
  );
}
