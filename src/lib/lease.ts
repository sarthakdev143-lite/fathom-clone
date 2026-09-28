import { randomUUID } from "node:crypto";
import { db } from "./db";
import { ROUTE_MAX_DURATION_SECONDS } from "./budget";

/**
 * A per-meeting processing lease.
 *
 * Without it, a user clicking Retry while a previous request is still working
 * (or the client re-calling after a 202 while a slow request is finishing)
 * would run two transcriptions of the same audio, double the provider bill and
 * race on the progress column. The lease is a conditional UPDATE, so exactly
 * one caller wins even across serverless instances.
 *
 * The TTL outlives the function's maximum duration: if the platform kills a
 * request mid-flight, its lease simply expires and the next caller takes over.
 */

export const LEASE_TTL_MS = (ROUTE_MAX_DURATION_SECONDS + 30) * 1000;

export interface Lease {
  owner: string;
  release(): Promise<void>;
  extend(): Promise<void>;
}

export async function acquireLease(
  meetingId: string,
  ttlMs = LEASE_TTL_MS,
): Promise<Lease | null> {
  const client = await db();
  const owner = randomUUID();
  const now = Date.now();

  const result = await client.execute({
    sql: `UPDATE meetings
             SET lease_owner = ?, lease_until = ?
           WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)`,
    args: [owner, now + ttlMs, meetingId, now],
  });

  if (Number(result.rowsAffected ?? 0) === 0) return null;

  return {
    owner,
    async release() {
      const c = await db();
      await c.execute({
        sql: `UPDATE meetings SET lease_owner = NULL, lease_until = NULL
               WHERE id = ? AND lease_owner = ?`,
        args: [meetingId, owner],
      });
    },
    async extend() {
      const c = await db();
      await c.execute({
        sql: `UPDATE meetings SET lease_until = ? WHERE id = ? AND lease_owner = ?`,
        args: [Date.now() + ttlMs, meetingId, owner],
      });
    },
  };
}
