/**
 * Time budget for one pipeline request.
 *
 * A Vercel function is killed when it exceeds `maxDuration`. Long meetings need
 * more work than fits in one invocation, so each request does as many units
 * (audio chunks, summary windows) as fit in its budget, persists progress, and
 * returns 202 for the client to call again. `deadline` is also handed to the
 * provider clients so a rate-limit backoff never sleeps past the function's
 * own lifetime.
 */

/** Matches `maxDuration` on the pipeline routes. */
export const ROUTE_MAX_DURATION_SECONDS = 300;

/** Stop starting new units after this long. Leaves room for one slow unit. */
const DEFAULT_BUDGET_MS = 200_000;

/** Provider retries must give up before the platform kills the function. */
const DEADLINE_MARGIN_MS = 25_000;

export interface Budget {
  /** Epoch ms after which no new unit of work should start. */
  readonly softLimit: number;
  /** Epoch ms by which every upstream call must have returned. */
  readonly deadline: number;
  /** True once no further unit should be started. */
  exhausted(): boolean;
}

export function createBudget(options?: {
  budgetMs?: number;
  now?: number;
}): Budget {
  const now = options?.now ?? Date.now();
  const configured = Number(process.env.PIPELINE_BUDGET_MS);
  const budgetMs =
    options?.budgetMs ??
    (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BUDGET_MS);

  const softLimit = now + budgetMs;
  const deadline = Math.max(
    softLimit,
    now + ROUTE_MAX_DURATION_SECONDS * 1000 - DEADLINE_MARGIN_MS,
  );

  return {
    softLimit,
    deadline,
    exhausted: () => Date.now() >= softLimit,
  };
}

/** For scripts and tests that should run to completion in one go. */
export function unlimitedBudget(): Budget {
  return {
    softLimit: Number.POSITIVE_INFINITY,
    deadline: Number.POSITIVE_INFINITY,
    exhausted: () => false,
  };
}
