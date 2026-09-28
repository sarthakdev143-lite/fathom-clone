import { unlimitedBudget, type Budget } from "./budget";
import { GeminiError } from "./gemini";
import { GroqError } from "./groq";
import { completeJson, type JsonCaller, defaultJsonCaller } from "./json-completion";
import { logEvent } from "./log";
import { isTransientProviderError } from "./providers";
import {
  getSegments,
  readProgress,
  requireMeeting,
  saveSummary,
  setStatus,
  writeProgress,
} from "./meetings";
import {
  REDUCE_INPUT_CHARS,
  REDUCE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  WINDOW_CHARS,
  buildReducePrompt,
  buildSectionPrompt,
  buildSummaryPrompt,
  buildWindows,
  fitsSinglePass,
  parseSummary,
  snapKeyMoments,
  type MeetingSummary,
} from "./summary";

export interface SummarizeOutcome {
  summary: MeetingSummary;
  /**
   * Always false now: long transcripts are summarised window by window rather
   * than sampled. Kept in the shape so existing callers and old rows still
   * read consistently.
   */
  sampled: boolean;
  segmentsUsed: number;
  segmentsTotal: number;
  /** 1 for a single-pass summary, otherwise the number of map windows. */
  windows: number;
  provider: "groq" | "gemini";
  fallbackReason: string | null;
}

export type SummarizeStep =
  | ({ done: true } & SummarizeOutcome)
  | {
      done: false;
      windowsDone: number;
      windowsTotal: number;
      /** Set when the providers are rate limited; the client should wait. */
      retryAfterSeconds?: number;
    };

interface SummaryProgress {
  v: 1;
  /** Identifies the transcript the partials belong to. */
  fingerprint: string;
  partials: (MeetingSummary | null)[];
}

const SECTION_MAX_TOKENS = 1500;
const FINAL_MAX_TOKENS = 2000;

function fingerprint(transcript: string, segmentCount: number): string {
  return `${transcript.length}:${segmentCount}:${WINDOW_CHARS}`;
}

/**
 * Does as much of step 3 as fits in `budget`, persisting progress.
 *
 * Short transcripts: one call, as before. Long transcripts: each window is
 * summarised and stored as it completes, then the section summaries are
 * merged. A request that runs out of budget returns `done: false` and the
 * next one picks up at the first window without a summary.
 *
 * Throws on non-transient failure; the caller records it on the meeting.
 */
export async function summarizeMeetingStep(
  id: string,
  options: { budget?: Budget; onUnit?: () => Promise<void>; call?: JsonCaller } = {},
): Promise<SummarizeStep> {
  const budget = options.budget ?? unlimitedBudget();
  const call = options.call ?? defaultJsonCaller;
  const meeting = await requireMeeting(id);

  if (!meeting.transcript || meeting.transcript.trim() === "") {
    throw new Error("This meeting has no transcript yet. Transcribe it first.");
  }

  const segments = await getSegments(id);
  const input = { title: meeting.title, transcript: meeting.transcript, segments };
  await setStatus(id, "summarizing");

  if (fitsSinglePass(input)) {
    const { prompt } = buildSummaryPrompt(input);
    const result = await completeJson(
      {
        system: SYSTEM_PROMPT,
        user: prompt,
        maxTokens: FINAL_MAX_TOKENS,
        deadline: budget.deadline,
        label: "summary",
      },
      parseSummary,
      call,
    ).catch((err: unknown) => {
      if (isTransientProviderError(err)) return null;
      throw err;
    });

    if (!result) return { done: false, windowsDone: 0, windowsTotal: 1, retryAfterSeconds: 20 };

    await saveSummary(id, result.value, {
      sampled: false,
      segmentsUsed: segments.length,
      segmentsTotal: segments.length,
    });
    return {
      done: true,
      summary: result.value,
      sampled: false,
      segmentsUsed: segments.length,
      segmentsTotal: segments.length,
      windows: 1,
      provider: result.provider,
      fallbackReason: result.fallbackReason,
    };
  }

  // ---- Map ---------------------------------------------------------------
  const windows = buildWindows(input);
  const print = fingerprint(meeting.transcript, segments.length);
  let progress = await readProgress<SummaryProgress>(id, "summary_progress_json");
  if (!progress || progress.v !== 1 || progress.fingerprint !== print ||
      progress.partials.length !== windows.length) {
    progress = { v: 1, fingerprint: print, partials: windows.map(() => null) };
  }

  let unitsThisRequest = 0;
  let fallbackReason: string | null = null;
  const notDone = (retryAfterSeconds?: number): SummarizeStep => ({
    done: false,
    windowsDone: progress!.partials.filter(Boolean).length,
    windowsTotal: windows.length,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  });

  for (let index = 0; index < windows.length; index++) {
    if (progress.partials[index]) continue;
    // Always make at least one unit of progress per request.
    if (unitsThisRequest > 0 && budget.exhausted()) return notDone();

    const started = Date.now();
    let result;
    try {
      result = await completeJson(
        {
          system: SYSTEM_PROMPT,
          user: buildSectionPrompt({
            title: meeting.title,
            window: windows[index],
            index,
            total: windows.length,
          }),
          maxTokens: SECTION_MAX_TOKENS,
          deadline: budget.deadline,
          label: `summary.section.${index + 1}`,
        },
        parseSummary,
        call,
      );
    } catch (err) {
      if (isTransientProviderError(err)) {
        logEvent("warn", "summarize.section_deferred", { meetingId: id, index });
        return notDone(20);
      }
      throw err;
    }

    fallbackReason ??= result.fallbackReason;
    progress.partials[index] = result.value;
    await writeProgress(id, "summary_progress_json", progress);
    await options.onUnit?.();
    unitsThisRequest++;

    logEvent("info", "summarize.section_done", {
      meetingId: id,
      index,
      total: windows.length,
      provider: result.provider,
      ms: Date.now() - started,
    });
  }

  if (unitsThisRequest > 0 && budget.exhausted()) return notDone();

  // ---- Reduce ------------------------------------------------------------
  const sections = windows.map((window, index) => ({
    label: window.label,
    summary: progress!.partials[index] as MeetingSummary,
  }));

  let merged;
  try {
    merged = await reduceSections(meeting.title, sections, budget, call);
  } catch (err) {
    if (isTransientProviderError(err)) return notDone(20);
    throw err;
  }

  const summary: MeetingSummary = {
    ...merged.value,
    key_moments: snapKeyMoments(merged.value.key_moments, segments),
  };

  await saveSummary(id, summary, {
    sampled: false,
    segmentsUsed: segments.length,
    segmentsTotal: segments.length,
  });

  return {
    done: true,
    summary,
    sampled: false,
    segmentsUsed: segments.length,
    segmentsTotal: segments.length,
    windows: windows.length,
    provider: merged.provider,
    fallbackReason: fallbackReason ?? merged.fallbackReason,
  };
}

/**
 * Merges section summaries. If they are too large for one call (a meeting of
 * several hours), they are merged in halves first and the halves merged
 * after, so no input is ever dropped to fit.
 */
async function reduceSections(
  title: string,
  sections: { label: string; summary: MeetingSummary }[],
  budget: Budget,
  call: JsonCaller,
): Promise<{ value: MeetingSummary; provider: "groq" | "gemini"; fallbackReason: string | null }> {
  const prompt = buildReducePrompt({ title, sections });

  if (prompt.length > REDUCE_INPUT_CHARS && sections.length > 2) {
    const middle = Math.ceil(sections.length / 2);
    const left = await reduceSections(title, sections.slice(0, middle), budget, call);
    const right = await reduceSections(title, sections.slice(middle), budget, call);
    const span = (part: typeof sections) =>
      `${part[0].label.split("-")[0]}-${part[part.length - 1].label.split("-").pop()}`;
    return reduceSections(
      title,
      [
        { label: span(sections.slice(0, middle)), summary: left.value },
        { label: span(sections.slice(middle)), summary: right.value },
      ],
      budget,
      call,
    );
  }

  return completeJson(
    {
      system: REDUCE_SYSTEM_PROMPT,
      user: prompt,
      maxTokens: FINAL_MAX_TOKENS,
      deadline: budget.deadline,
      label: "summary.reduce",
    },
    parseSummary,
    call,
  );
}

/**
 * Runs step 3 to completion in one call. Used by the seed script, where there
 * is no request lifetime to respect.
 */
export async function summarizeMeeting(id: string): Promise<SummarizeOutcome> {
  for (let i = 0; i < 100; i++) {
    const step = await summarizeMeetingStep(id, { budget: unlimitedBudget() });
    if (step.done) return step;
    await new Promise((r) => setTimeout(r, (step.retryAfterSeconds ?? 1) * 1000));
  }
  throw new Error("Summarization did not finish.");
}

export { GeminiError, GroqError };
