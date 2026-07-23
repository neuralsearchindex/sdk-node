import type { Context, MiddlewareHandler } from "hono";
import type { Logger } from "pino";

// Context keys the middleware writes; read them with getRequestLogger/getRequestId.
const LOGGER_KEY = "logger";
const REQUEST_ID_KEY = "requestId";

/**
 * Hono request-logging middleware.
 *
 * For every request it:
 *  - assigns a request id (honouring an inbound `x-request-id`) and echoes it
 *    back on the response,
 *  - stashes a request-scoped child logger on the context (`getRequestLogger`),
 *  - logs one completion line with method, path, status and duration — at
 *    `error` for 5xx, `warn` for 4xx, `info` otherwise.
 *
 * ```ts
 * app.use("*", honoLogger(logger));
 * app.get("/x", (c) => { getRequestLogger(c).debug("handling"); return c.json({}); });
 * ```
 */
export function honoLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    const reqLog = logger.child({
      requestId,
      method: c.req.method,
      path: c.req.path,
    });

    c.set(LOGGER_KEY, reqLog);
    c.set(REQUEST_ID_KEY, requestId);
    c.header("x-request-id", requestId);

    try {
      await next();
    } finally {
      const durationMs = Math.round(performance.now() - start);
      const status = c.res.status;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      reqLog[level](
        { status, durationMs },
        `${c.req.method} ${c.req.path} ${status} ${durationMs}ms`
      );
    }
  };
}

/**
 * The request-scoped child logger set by {@link honoLogger}. Falls back to the
 * supplied logger (or a throwaway) if the middleware is not mounted.
 */
export function getRequestLogger(c: Context, fallback?: Logger): Logger {
  return (c.get(LOGGER_KEY) as Logger | undefined) ?? (fallback as Logger);
}

/** The request id assigned by {@link honoLogger}, if mounted. */
export function getRequestId(c: Context): string | undefined {
  return c.get(REQUEST_ID_KEY) as string | undefined;
}
