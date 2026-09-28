"use client";

import { useState } from "react";
import {
  exportFilename,
  transcriptToMarkdown,
  transcriptToSrt,
  transcriptToText,
  type ExportSegment,
} from "@/lib/export";

/**
 * Download the transcript without another server round trip: the page already
 * rendered it, so the file is assembled here from the same props.
 */
export default function TranscriptExport(props: {
  title: string;
  date: string;
  language: string | null;
  tldr: string | null;
  segments: ExportSegment[];
  plainText: string | null;
  hasTimings: boolean;
}) {
  const [open, setOpen] = useState(false);

  const download = (format: "md" | "txt" | "srt") => {
    const body =
      format === "md"
        ? transcriptToMarkdown(props)
        : format === "txt"
          ? transcriptToText(props)
          : transcriptToSrt(props.segments);
    if (body === null || body === "") return;

    const url = URL.createObjectURL(
      new Blob([body], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(props.title, format);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  const empty = props.segments.length === 0 && !props.plainText?.trim();
  if (empty) return null;

  return (
    <span className="export" style={{ position: "relative", display: "inline-block" }}>
      <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
        Export
      </button>
      {open && (
        <span
          className="card"
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 0.4rem)",
            zIndex: 10,
            padding: "0.5rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
            minWidth: "11rem",
          }}
        >
          <button type="button" className="btn" role="menuitem" onClick={() => download("md")}>
            Markdown (.md)
          </button>
          <button type="button" className="btn" role="menuitem" onClick={() => download("txt")}>
            Plain text (.txt)
          </button>
          <button
            type="button"
            className="btn"
            role="menuitem"
            disabled={!props.hasTimings}
            title={
              props.hasTimings
                ? "Subtitles with timestamps"
                : "Needs transcript timings, which the fallback provider does not return"
            }
            onClick={() => download("srt")}
          >
            Subtitles (.srt)
          </button>
        </span>
      )}
    </span>
  );
}
