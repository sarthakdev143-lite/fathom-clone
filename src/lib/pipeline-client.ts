/**
 * Browser-side driver for the resumable pipeline routes.
 *
 * `/transcribe` and `/summarize` do as much work as fits in one function
 * invocation and answer 202 when there is more. This keeps calling until the
 * stage is done, and treats the in-between conditions as waits rather than
 * errors:
 *
 *   202  progress saved; call again (after `retryAfterSeconds` if given)
 *   409  another request holds the lease; wait and ask again
 *   429  our own rate limit; wait out Retry-After
 *   502/504 with a non-JSON body - the platform killed the function. Progress
 *        up to the last chunk is saved, so this is retried a few times.
 *
 * Anything else is a real error and is thrown with the server's message.
 */

export type PipelineStage = "transcribe" | "summarize";

export interface StageProgress {
  stage: PipelineStage;
  /** Seconds of audio transcribed so far (transcribe only). */
  processedSeconds?: number;
  windowsDone?: number;
  windowsTotal?: number;
  /** True while waiting on another request, a rate limit, or a restart. */
  waiting?: boolean;
}

const MAX_CALLS = 120;
const MAX_CONSECUTIVE_PLATFORM_ERRORS = 3;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export async function runStage<T = any>(
  meetingId: string,
  stage: PipelineStage,
  options: {
    onProgress?: (progress: StageProgress) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    /** Scales every wait; tests pass 0. */
    waitScale?: number;
  } = {},
): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  const scale = options.waitScale ?? 1;
  let platformErrors = 0;

  for (let call = 0; call < MAX_CALLS; call++) {
    let response: Response;
    try {
      response = await doFetch(`/api/meetings/${meetingId}/${stage}`, {
        method: "POST",
        signal: options.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      platformErrors++;
      if (platformErrors > MAX_CONSECUTIVE_PLATFORM_ERRORS) {
        throw new Error("Could not reach the server. Check your connection and retry.");
      }
      options.onProgress?.({ stage, waiting: true });
      await sleep(3000 * platformErrors * scale, options.signal);
      continue;
    }

    const payload = await response.json().catch(() => null);

    if (response.ok && response.status !== 202) return payload as T;

    if (response.status === 202) {
      platformErrors = 0;
      options.onProgress?.({ stage, ...(payload?.progress ?? {}) });
      const wait = Number(payload?.retryAfterSeconds) || 0;
      if (wait > 0) {
        options.onProgress?.({ stage, ...(payload?.progress ?? {}), waiting: true });
        await sleep(wait * 1000 * scale, options.signal);
      }
      continue;
    }

    if (response.status === 409 && payload?.inProgress) {
      options.onProgress?.({ stage, waiting: true });
      await sleep((Number(payload.retryAfterSeconds) || 5) * 1000 * scale, options.signal);
      continue;
    }

    if (response.status === 429) {
      const wait = Math.min(
        90,
        Number(payload?.retryAfterSeconds) || Number(response.headers.get("retry-after")) || 10,
      );
      options.onProgress?.({ stage, waiting: true });
      await sleep(wait * 1000 * scale, options.signal);
      continue;
    }

    // A timed-out or crashed function comes back as a platform error page,
    // not our JSON. The work up to the last saved chunk survives it.
    if (payload === null && (response.status === 502 || response.status === 504 || response.status === 500)) {
      platformErrors++;
      if (platformErrors <= MAX_CONSECUTIVE_PLATFORM_ERRORS) {
        options.onProgress?.({ stage, waiting: true });
        await sleep(2000 * scale, options.signal);
        continue;
      }
    }

    throw new Error(
      payload?.error ??
        `${stage === "transcribe" ? "Transcription" : "Summarization"} failed (HTTP ${response.status}).`,
    );
  }

  throw new Error(
    `${stage === "transcribe" ? "Transcription" : "Summarization"} is taking unusually long. ` +
      "Progress is saved; retry from the meeting page.",
  );
}

export function describeProgress(progress: StageProgress | null): string | null {
  if (!progress) return null;
  if (progress.waiting) return "Waiting for the provider, progress is saved...";
  if (progress.stage === "transcribe" && progress.processedSeconds) {
    const m = Math.floor(progress.processedSeconds / 60);
    return `Transcribed ${m} min so far...`;
  }
  if (progress.stage === "summarize" && progress.windowsTotal) {
    return `Summarised ${progress.windowsDone ?? 0} of ${progress.windowsTotal} sections...`;
  }
  return null;
}
