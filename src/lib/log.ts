/**
 * Structured logging.
 *
 * One JSON object per line, so Vercel's log drains (and anything downstream of
 * them: Datadog, Axiom, Better Stack) can filter on `event`, `meetingId` and
 * `level` without regex-parsing prose. Nothing here buffers or sends anything
 * itself; stdout is the transport.
 */

export type LogLevel = "info" | "warn" | "error";

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (process.env.LOG_LEVEL === "silent") return;
  const line = JSON.stringify({
    level,
    event,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** The useful parts of an error, without a multi-kilobyte stack in every line. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const record = err as Error & { status?: unknown; detail?: unknown; code?: unknown };
  return {
    error: err.message,
    errorName: err.name,
    ...(record.status !== undefined ? { upstreamStatus: record.status } : {}),
    ...(typeof record.detail === "string" && record.detail
      ? { detail: record.detail.slice(0, 500) }
      : {}),
    ...(record.code !== undefined && record.code !== null ? { code: record.code } : {}),
  };
}
