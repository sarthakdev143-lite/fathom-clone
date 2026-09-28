"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

interface SearchHit {
  field: string;
  label: string;
  snippet: string;
  timestamp: number | null;
}

interface SearchResult {
  id: string;
  title: string;
  created_at: string;
  hits: SearchHit[];
}

const DEBOUNCE_MS = 250;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Query words worth highlighting; single letters would mark everything. */
function highlightTokens(query: string): string[] {
  const tokens = query
    .split(/\s+/)
    .map((part) => part.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ""))
    .filter((part) => part.length >= 2);
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}

/** Splits text on the query tokens so matches render in <mark>, safely. */
function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
  if (tokens.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
      )}
    </>
  );
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Search box for the dashboard. While the query is empty the full meeting
 * list (passed as children) shows; once the user types, a debounced fetch to
 * /api/search replaces it with grouped results. Transcript hits deep-link
 * with ?t= so playback starts at the matching line.
 */
export default function MeetingSearch({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [committed, setCommitted] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function handleChange(value: string) {
    setQuery(value);
    if (value.trim()) {
      setSearching(true);
      return;
    }
    // Empty query restores the full list; handled here rather than in the
    // effect below so no state updates happen inside an effect body.
    abortRef.current?.abort();
    setCommitted("");
    setResults(null);
    setSearching(false);
    setFailed(false);
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { results: SearchResult[] };
        setResults(data.results);
        setCommitted(trimmed);
        setFailed(false);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCommitted(trimmed);
        setFailed(true);
      } finally {
        if (abortRef.current === controller) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!query.trim()) {
    return (
      <div className="search">
        <input
          type="search"
          className="search-input"
          placeholder="Search titles, summaries and transcripts…"
          aria-label="Search meetings"
          value={query}
          onChange={(event) => handleChange(event.target.value)}
        />
        {children}
      </div>
    );
  }

  const tokens = highlightTokens(committed);

  return (
    <div className="search">
      <input
        type="search"
        className="search-input"
        placeholder="Search titles, summaries and transcripts…"
        aria-label="Search meetings"
        value={query}
        onChange={(event) => handleChange(event.target.value)}
      />
      <div aria-live="polite">
        {searching && results === null && !failed ? (
          <p className="muted">Searching…</p>
        ) : failed ? (
          <p className="error" role="alert">
            Search failed. Try again.
          </p>
        ) : results !== null && results.length === 0 ? (
          <div className="card">
            <p style={{ margin: 0 }}>
              No meetings match &ldquo;{committed}&rdquo;.
            </p>
            <p className="muted small" style={{ margin: "0.35rem 0 0" }}>
              Only summarised meetings are searched.
            </p>
          </div>
        ) : results !== null ? (
          <>
            <p className="muted small search-count">
              {results.length === 1 ? "1 meeting" : `${results.length} meetings`}
              {searching ? " · searching…" : ""}
            </p>
            {results.map((group) => (
              <section key={group.id} className="card search-group">
                <Link href={`/meetings/${group.id}`} className="search-group-title">
                  {group.title}
                </Link>
                <p className="muted small search-group-meta">{formatDate(group.created_at)}</p>
                <ul className="search-hits">
                  {group.hits.map((hit, index) => (
                    <li key={index}>
                      <Link
                        href={
                          hit.timestamp !== null
                            ? `/meetings/${group.id}?t=${hit.timestamp}`
                            : `/meetings/${group.id}`
                        }
                        className="search-hit"
                      >
                        <span className="search-hit-meta">
                          {hit.label}
                          {hit.timestamp !== null ? ` · ${formatClock(hit.timestamp)}` : ""}
                        </span>
                        <span className="search-hit-text">
                          <Highlight text={hit.snippet} tokens={tokens} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
