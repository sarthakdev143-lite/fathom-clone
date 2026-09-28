import type { Instrumentation } from "next";

/**
 * Next.js calls this for every uncaught error in a route handler, server
 * component or server action. Logging it as one structured line means an
 * unhandled 500 shows up in the log drain with its route and digest instead of
 * as an anonymous stack trace. Swap the body for Sentry.captureRequestError if
 * an error tracker is added later; the hook is the same.
 */
export function register() {}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  const err = error as Error & { digest?: string };
  console.error(
    JSON.stringify({
      level: "error",
      event: "request.unhandled_error",
      time: new Date().toISOString(),
      error: err?.message ?? String(error),
      errorName: err?.name,
      digest: err?.digest,
      method: request.method,
      path: request.path,
      routePath: context.routePath,
      routeType: context.routeType,
      stack: err?.stack?.split("\n").slice(0, 8).join("\n"),
    }),
  );
};
