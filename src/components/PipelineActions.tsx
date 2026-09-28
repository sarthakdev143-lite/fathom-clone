"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  describeProgress,
  runStage,
  type PipelineStage,
  type StageProgress,
} from "@/lib/pipeline-client";
import type { MeetingStatus } from "@/lib/types";

/**
 * Retry and resume controls for a meeting that is not `ready`.
 *
 * Both pipeline stages are idempotent and resumable, so every stuck state has
 * a way forward from here: a failed transcription re-runs (continuing from the
 * last saved chunk), a failed summary re-runs without re-transcribing, an
 * abandoned upload gets processed, and an interrupted live recording can be
 * summarised from the partial transcript it captured.
 */

interface Props {
  meetingId: string;
  status: MeetingStatus;
  /** The meeting has audio the transcribe route can read. */
  canTranscribe: boolean;
  hasTranscript: boolean;
  /** Another request currently holds the processing lease. */
  processingElsewhere: boolean;
}

interface Action {
  label: string;
  stages: PipelineStage[];
  primary: boolean;
}

function actionsFor(props: Props): Action[] {
  const { status, canTranscribe, hasTranscript, processingElsewhere } = props;
  const full: Action = {
    label: "Transcribe and summarize",
    stages: ["transcribe", "summarize"],
    primary: true,
  };

  switch (status) {
    case "ready":
    case "live":
      return [];
    case "uploaded":
      return canTranscribe ? [full] : [];
    case "transcribed":
      return [{ label: "Summarize", stages: ["summarize"], primary: true }];
    case "transcribing":
      if (processingElsewhere) return [];
      return canTranscribe ? [{ ...full, label: "Resume transcription" }] : [];
    case "summarizing":
      if (processingElsewhere) return [];
      return hasTranscript ? [{ label: "Resume summary", stages: ["summarize"], primary: true }] : [];
    case "failed": {
      const actions: Action[] = [];
      if (hasTranscript) {
        actions.push({
          label: canTranscribe ? "Retry summary" : "Summarize partial transcript",
          stages: ["summarize"],
          primary: true,
        });
      }
      if (canTranscribe) {
        actions.push({
          label: hasTranscript ? "Re-transcribe" : "Retry transcription",
          stages: ["transcribe", "summarize"],
          primary: !hasTranscript,
        });
      }
      return actions;
    }
  }
}

export default function PipelineActions(props: Props) {
  const router = useRouter();
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState<StageProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: Action) => {
      setRunning(action.label);
      setError(null);
      try {
        for (const stage of action.stages) {
          setProgress({ stage });
          await runStage(props.meetingId, stage, { onProgress: setProgress });
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        router.refresh();
      } finally {
        setRunning(null);
        setProgress(null);
      }
    },
    [props.meetingId, router],
  );

  const actions = actionsFor(props);

  if (props.processingElsewhere && (props.status === "transcribing" || props.status === "summarizing")) {
    return (
      <p className="muted small" role="status" style={{ marginBottom: "1.5rem" }}>
        This meeting is being processed by another request. Reload in a moment
        to see the result.
      </p>
    );
  }

  if (actions.length === 0) return null;

  const status =
    running &&
    (describeProgress(progress) ??
      (progress?.stage === "summarize" ? "Summarizing..." : "Transcribing..."));

  return (
    <div className="card" style={{ marginBottom: "1.5rem" }}>
      <div className="row" style={{ marginTop: 0 }}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.primary ? "btn btn-primary" : "btn"}
            disabled={running !== null}
            onClick={() => void run(action)}
          >
            {running === action.label ? "Working..." : action.label}
          </button>
        ))}
      </div>
      {status && (
        <p className="muted small" aria-live="polite" style={{ margin: "0.75rem 0 0" }}>
          {status} If you leave, progress is kept and this picks up where it stopped.
        </p>
      )}
      {error && (
        <p className="error" role="alert" style={{ margin: "0.75rem 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}
