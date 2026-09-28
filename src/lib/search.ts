import { db } from "./db";
import type { MeetingSummary } from "./summary";

/**
 * Cross-meeting search over ready meetings: titles, summary fields and
 * transcript text. No model calls — pure SQLite.
 *
 * Two engines, one snippet builder. FTS5 (`meeting_fts`, kept fresh by
 * triggers) ranks with bm25; when the virtual table cannot be built — an
 * SQLite without the FTS5 module — the same query runs as LIKE with a LIMIT.
 * Both paths return candidate rows; snippets and timestamps are then derived
 * in JS so the two modes render identically.
 */

export interface SearchHit {
  field: "title" | "summary" | "transcript";
  /** Human label, e.g. "Topic" or "Transcript". */
  label: string;
  /** Plain text excerpt. Highlighting happens client-side (no innerHTML). */
  snippet: string;
  /** Segment start for transcript hits, so they can link with ?t=. */
  timestamp: number | null;
}

export interface SearchResult {
  id: string;
  title: string;
  created_at: string;
  hits: SearchHit[];
}

export type SearchMode = "fts" | "like";

const MAX_QUERY_LENGTH = 200;
const MAX_MEETINGS = 20;
const MAX_HITS_PER_MEETING = 3;
const MAX_TOKENS = 10;
const SNIPPET_RADIUS = 60;

let ftsReady: Promise<boolean> | null = null;

/**
 * Creates the FTS index and its triggers if possible, backfilling rows that
 * predate it. Resolves false — rather than throwing — when FTS5 is missing,
 * so callers can fall back to LIKE. Cached per process.
 */
function ensureSearchIndex(): Promise<boolean> {
  if (!ftsReady) {
    ftsReady = buildIndex().catch(() => false);
  }
  return ftsReady;
}

async function buildIndex(): Promise<boolean> {
  const client = await db();
  try {
    await client.execute(
      `CREATE VIRTUAL TABLE IF NOT EXISTS meeting_fts USING fts5(
         meeting_id UNINDEXED, title, summary_text, transcript, tokenize='porter'
       )`,
    );
    await client.execute(
      `CREATE TRIGGER IF NOT EXISTS meetings_fts_ai AFTER INSERT ON meetings BEGIN
         INSERT INTO meeting_fts(rowid, meeting_id, title, summary_text, transcript)
         VALUES (new.rowid, new.id, new.title,
                 COALESCE(new.summary_json, ''), COALESCE(new.transcript, ''));
       END`,
    );
    await client.execute(
      `CREATE TRIGGER IF NOT EXISTS meetings_fts_ad AFTER DELETE ON meetings BEGIN
         DELETE FROM meeting_fts WHERE rowid = old.rowid;
       END`,
    );
    await client.execute(
      `CREATE TRIGGER IF NOT EXISTS meetings_fts_au
         AFTER UPDATE OF title, summary_json, transcript ON meetings BEGIN
         DELETE FROM meeting_fts WHERE rowid = old.rowid;
         INSERT INTO meeting_fts(rowid, meeting_id, title, summary_text, transcript)
         VALUES (new.rowid, new.id, new.title,
                 COALESCE(new.summary_json, ''), COALESCE(new.transcript, ''));
       END`,
    );
    // Rows inserted before the triggers existed have no FTS entry.
    await client.execute(
      `INSERT INTO meeting_fts(rowid, meeting_id, title, summary_text, transcript)
       SELECT rowid, id, title, COALESCE(summary_json, ''), COALESCE(transcript, '')
       FROM meetings WHERE rowid NOT IN (SELECT rowid FROM meeting_fts)`,
    );
    return true;
  } catch {
    return false;
  }
}

interface QueryToken {
  /** Lowercased, for snippet matching. */
  text: string;
  /** Escaped LIKE pattern fragment, e.g. `%foo\%bar%` handled by caller. */
  raw: string;
}

/** Splits a query into searchable tokens; single characters match too much. */
function tokenize(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const part of query.split(/\s+/)) {
    const cleaned = part.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
    if (cleaned.length < 2) continue;
    tokens.push({ text: cleaned.toLowerCase(), raw: cleaned });
    if (tokens.length >= MAX_TOKENS) break;
  }
  return tokens;
}

/** `"checkout"* OR "latency"*` — prefix so partial words still match. */
function buildFtsMatch(tokens: QueryToken[]): string {
  return tokens
    .map((token) => `"${token.raw.replace(/"/g, '""')}"*`)
    .join(" OR ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

interface CandidateRow {
  id: string;
  title: string;
  summary_json: string | null;
  transcript: string | null;
  transcript_segments_json: string | null;
  created_at: string;
}

const CANDIDATE_COLUMNS = `id, title, summary_json, transcript,
  transcript_segments_json, created_at`;

async function candidatesByFts(match: string): Promise<CandidateRow[]> {
  const client = await db();
  const found = await client.execute({
    sql: `SELECT m.${CANDIDATE_COLUMNS.replace(/,\s*/g, ", m.")}
          FROM meeting_fts f JOIN meetings m ON m.id = f.meeting_id
          WHERE f.meeting_fts MATCH ? AND m.status = 'ready'
          ORDER BY f.rank LIMIT ${MAX_MEETINGS}`,
    args: [match],
  });
  return found.rows as unknown as CandidateRow[];
}

async function candidatesByLike(tokens: QueryToken[]): Promise<CandidateRow[]> {
  const client = await db();
  const limited = tokens.slice(0, 5);
  const clauses = limited
    .map(() => `(title LIKE ? ESCAPE '\\' OR summary_json LIKE ? OR transcript LIKE ?)`)
    .join(" OR ");
  const args: string[] = [];
  for (const token of limited) {
    const pattern = `%${escapeLike(token.raw)}%`;
    args.push(pattern, pattern, pattern);
  }
  const found = await client.execute({
    sql: `SELECT ${CANDIDATE_COLUMNS} FROM meetings
          WHERE status = 'ready' AND (${clauses})
          ORDER BY created_at DESC LIMIT ${MAX_MEETINGS}`,
    args,
  });
  return found.rows as unknown as CandidateRow[];
}

interface Segment {
  start: number;
  text: string;
}

function parseSegments(raw: string | null): Segment[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const segments: Segment[] = [];
    for (const entry of parsed) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { start: unknown }).start === "number" &&
        typeof (entry as { text: unknown }).text === "string"
      ) {
        segments.push({
          start: (entry as Segment).start,
          text: (entry as Segment).text,
        });
      }
    }
    return segments;
  } catch {
    return [];
  }
}

function parseSummaryFields(raw: string | null): { label: string; text: string }[] {
  if (!raw) return [];
  let summary: MeetingSummary;
  try {
    summary = JSON.parse(raw) as MeetingSummary;
  } catch {
    return [];
  }
  const fields: { label: string; text: string }[] = [];
  if (typeof summary.tldr === "string" && summary.tldr) {
    fields.push({ label: "Summary", text: summary.tldr });
  }
  for (const topic of summary.topics ?? []) {
    if (typeof topic === "string" && topic) fields.push({ label: "Topic", text: topic });
  }
  for (const decision of summary.decisions ?? []) {
    if (typeof decision === "string" && decision) {
      fields.push({ label: "Decision", text: decision });
    }
  }
  for (const item of summary.action_items ?? []) {
    if (item && typeof item.task === "string" && item.task) {
      fields.push({ label: "Action", text: item.task });
    }
  }
  for (const moment of summary.key_moments ?? []) {
    if (moment && typeof moment.label === "string" && moment.label) {
      fields.push({ label: "Key moment", text: moment.label });
    }
  }
  return fields;
}

/** Earliest case-insensitive occurrence of any token, or -1. */
function earliestHit(haystack: string, tokens: QueryToken[]): number {
  const lower = haystack.toLowerCase();
  let best = -1;
  for (const token of tokens) {
    const index = lower.indexOf(token.text);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  return best;
}

function windowed(text: string, index: number, tokenLength: number): string {
  // Sliced on code points, not UTF-16 units: cutting a surrogate pair in half
  // produces a lone surrogate that renders as �. `index` is a UTF-16 offset
  // from indexOf, so it is converted first.
  const points = Array.from(text);
  if (points.length <= SNIPPET_RADIUS * 2 + tokenLength) return text;
  const hitAt = Array.from(text.slice(0, index)).length;
  const start = Math.max(0, hitAt - SNIPPET_RADIUS);
  const end = Math.min(points.length, hitAt + tokenLength + SNIPPET_RADIUS);
  let excerpt = points.slice(start, end).join("");
  // Snap to word boundaries so excerpts neither start nor end mid-word.
  if (start > 0) {
    const cut = excerpt.indexOf(" ");
    excerpt = cut === -1 ? "" : excerpt.slice(cut + 1);
  }
  if (end < points.length) {
    const cut = excerpt.lastIndexOf(" ");
    excerpt = `${cut === -1 ? excerpt : excerpt.slice(0, cut)}\u2026`;
  }
  if (excerpt === "") return points.slice(start, end).join("");
  return `${start > 0 ? "\u2026" : ""}${excerpt}`;
}

function buildHits(row: CandidateRow, tokens: QueryToken[]): SearchHit[] {
  const hits: SearchHit[] = [];

  const titleAt = earliestHit(row.title, tokens);
  if (titleAt !== -1) {
    hits.push({ field: "title", label: "Title", snippet: row.title, timestamp: null });
  }

  // Transcript first: a timestamped hit deep-links into playback.
  const segments = parseSegments(row.transcript_segments_json);
  const queryLower = tokens.map((token) => token.text);
  let transcriptHit: SearchHit | null = null;
  if (segments.length > 0) {
    let best: Segment | null = null;
    let bestScore = -1;
    for (const segment of segments) {
      const lower = segment.text.toLowerCase();
      let score = 0;
      for (const token of queryLower) {
        if (lower.includes(token)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = segment;
      }
    }
    if (best && bestScore > 0) {
      transcriptHit = {
        field: "transcript",
        label: "Transcript",
        snippet: best.text,
        timestamp: best.start,
      };
    }
  } else if (row.transcript) {
    const at = earliestHit(row.transcript, tokens);
    if (at !== -1) {
      const tokenLength = tokens
        .map((token) => token.text.length)
        .reduce((a, b) => Math.max(a, b), 0);
      transcriptHit = {
        field: "transcript",
        label: "Transcript",
        snippet: windowed(row.transcript, at, tokenLength),
        timestamp: null,
      };
    }
  }
  if (transcriptHit) hits.push(transcriptHit);

  const summaryHits: SearchHit[] = [];
  for (const field of parseSummaryFields(row.summary_json)) {
    const at = earliestHit(field.text, tokens);
    if (at !== -1) {
      const tokenLength = tokens
        .map((token) => token.text.length)
        .reduce((a, b) => Math.max(a, b), 0);
      summaryHits.push({
        field: "summary",
        label: field.label,
        snippet: windowed(field.text, at, tokenLength),
        timestamp: null,
      });
      if (summaryHits.length >= 2) break;
    }
  }
  hits.push(...summaryHits);

  return hits.slice(0, MAX_HITS_PER_MEETING);
}

export async function searchMeetings(
  rawQuery: string,
): Promise<{ mode: SearchMode; results: SearchResult[] }> {
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  const tokens = tokenize(query);
  if (tokens.length === 0) return { mode: "fts", results: [] };

  let candidates: CandidateRow[] | null = null;
  let mode: SearchMode = "fts";

  if (await ensureSearchIndex()) {
    try {
      candidates = await candidatesByFts(buildFtsMatch(tokens));
    } catch {
      candidates = null;
    }
  }
  if (candidates === null) {
    mode = "like";
    try {
      candidates = await candidatesByLike(tokens);
    } catch {
      return { mode, results: [] };
    }
  }

  const results: SearchResult[] = [];
  for (const row of candidates) {
    const hits = buildHits(row, tokens);
    // FTS stemming can match a row no substring finds (e.g. "running" for
    // "run"); an empty group would be a confusing result, so skip it.
    if (hits.length === 0) continue;
    results.push({ id: row.id, title: row.title, created_at: row.created_at, hits });
  }
  return { mode, results };
}
