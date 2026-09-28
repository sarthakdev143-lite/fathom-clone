import { NextResponse } from "next/server";
import { db } from "./db";
import { errorFields, logEvent } from "./log";

/**
 * Per-client fixed-window rate limiting for the endpoints that cost money
 * (model calls) or storage (upload tokens).
 *
 * This is not authentication - there is still none - but it stops a single
 * client from draining the Groq quota or filling the blob store with a loop.
 * Counters live in the database because serverless instances share nothing
 * else; an in-memory limiter would reset on every cold start and be per
 * instance.
 *
 * It fails open: if the counter cannot be written, the request is allowed and
 * the failure is logged. A broken limiter must not take the product down.
 */

export interface RateRule {
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_RULES = {
  uploadToken: { name: "upload-token", limit: 30, windowSeconds: 600 },
  createMeeting: { name: "create-meeting", limit: 30, windowSeconds: 600 },
  liveStart: { name: "live-start", limit: 15, windowSeconds: 600 },
  // The live client sends a slice every 6-15 s, so ~10/min per session.
  liveChunk: { name: "live-chunk", limit: 45, windowSeconds: 60 },
  // Long meetings take several resumable calls each.
  transcribe: { name: "transcribe", limit: 40, windowSeconds: 600 },
  summarize: { name: "summarize", limit: 40, windowSeconds: 600 },
  search: { name: "search", limit: 90, windowSeconds: 60 },
} satisfies Record<string, RateRule>;

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "anonymous";
}

export interface RateDecision {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  key: string,
  rule: RateRule,
  now = Date.now(),
): Promise<RateDecision> {
  const nowSeconds = Math.floor(now / 1000);
  const windowStart = nowSeconds - (nowSeconds % rule.windowSeconds);
  const retryAfterSeconds = windowStart + rule.windowSeconds - nowSeconds;

  const client = await db();
  const result = await client.execute({
    sql: `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
          RETURNING count`,
    args: [`${rule.name}:${key}`, windowStart],
  });

  const count = Number(result.rows[0]?.count ?? 1);
  return {
    allowed: count <= rule.limit,
    count,
    limit: rule.limit,
    retryAfterSeconds: Math.max(1, retryAfterSeconds),
  };
}

/**
 * Returns a 429 response when the caller is over the limit, or null to
 * proceed. Route handlers call this before doing any billable work.
 */
export async function rateLimit(
  request: Request,
  rule: RateRule,
): Promise<NextResponse | null> {
  if (process.env.RATE_LIMIT_DISABLED === "1") return null;

  const key = clientKey(request);
  let decision: RateDecision;
  try {
    decision = await checkRateLimit(key, rule);
  } catch (err) {
    logEvent("warn", "rate_limit.unavailable", { rule: rule.name, ...errorFields(err) });
    return null;
  }

  if (decision.allowed) return null;

  logEvent("warn", "rate_limit.rejected", {
    rule: rule.name,
    key,
    count: decision.count,
    limit: decision.limit,
  });

  return NextResponse.json(
    {
      error: `Too many requests. Try again in ${decision.retryAfterSeconds} seconds.`,
      retryAfterSeconds: decision.retryAfterSeconds,
      // The live client backs its cadence off on this flag.
      rateLimited: true,
    },
    {
      status: 429,
      headers: { "Retry-After": String(decision.retryAfterSeconds) },
    },
  );
}
