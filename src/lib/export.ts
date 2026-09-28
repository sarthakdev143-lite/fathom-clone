/**
 * Transcript export. Pure functions, no I/O: the page already has the
 * transcript, so downloading is built client-side with a Blob and costs no
 * server work, no model call, no rate limit.
 */

export interface ExportSegment {
  start: number;
  end: number;
  text: string;
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "00:01:14,500" - SRT timestamps are comma decimals, always with hours. */
export function formatSrtTime(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.floor((clamped % 1) * 1000);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

export function transcriptToText(input: {
  segments: ExportSegment[];
  plainText: string | null;
}): string {
  if (input.segments.length > 0) {
    return input.segments.map((s) => `[${formatClock(s.start)}] ${s.text}`).join("\n");
  }
  return input.plainText?.trim() ?? "";
}

export function transcriptToMarkdown(input: {
  title: string;
  date: string;
  language: string | null;
  tldr: string | null;
  segments: ExportSegment[];
  plainText: string | null;
}): string {
  const lines = [
    `# ${input.title}`,
    "",
    `${input.date}${input.language ? ` · ${input.language}` : ""}`,
    "",
  ];
  if (input.tldr) {
    lines.push("## Summary", "", input.tldr, "");
  }
  lines.push("## Transcript", "");
  if (input.segments.length > 0) {
    for (const s of input.segments) {
      lines.push(`**[${formatClock(s.start)}]** ${s.text}`, "");
    }
  } else if (input.plainText?.trim()) {
    lines.push(input.plainText.trim(), "");
  } else {
    lines.push("_No transcript._", "");
  }
  return lines.join("\n");
}

/**
 * Null when there are no timed segments: an SRT without timings is not
 * subtitles, and the UI disables the option instead of writing a lie.
 */
export function transcriptToSrt(segments: ExportSegment[]): string | null {
  if (segments.length === 0) return null;
  return (
    segments
      .map(
        (s, i) =>
          `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text}\n`,
      )
      .join("\n") + "\n"
  );
}

/** "Q3 checkout planning sync" -> "q3-checkout-planning-sync". */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "meeting";
}

export function exportFilename(title: string, ext: "md" | "txt" | "srt"): string {
  return `${slugify(title)}.${ext}`;
}
