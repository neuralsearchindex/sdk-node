import pino, { type Logger, type LoggerOptions } from "pino";
import pretty from "pino-pretty";

export type { Logger } from "pino";

export interface CreateLoggerOptions {
  /**
   * Service / component name. Emitted as `service` on every line and shown in
   * the pretty prefix (`[reranker] ...`) so you can tell which microservice a
   * log came from when several stream to the same console.
   */
  name: string;
  /** Overrides `LOG_LEVEL` env / the NODE_ENV-derived default. */
  level?: pino.Level | string;
  /**
   * Force human-readable pretty output on/off. Defaults to pretty in dev and
   * raw JSON in production (`NODE_ENV=production`), overridable via `LOG_PRETTY`.
   */
  pretty?: boolean;
  /** Extra static fields merged onto every line (e.g. `{ version }`). */
  base?: Record<string, unknown>;
}

const isProd = process.env.NODE_ENV === "production";

function resolveLevel(explicit?: string): string {
  return explicit ?? process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");
}

function resolvePretty(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  if (process.env.LOG_PRETTY === "true") return true;
  if (process.env.LOG_PRETTY === "false") return false;
  return !isProd;
}

/**
 * Build a named logger for a service or app.
 *
 * Dev: colourised single-line output via `pino-pretty` (attached as a stream
 * rather than a transport target, which sidesteps worker-thread module
 * resolution in the pnpm symlinked monorepo). Prod: newline-delimited JSON to
 * stdout, ready for a log collector.
 *
 * ```ts
 * const log = createLogger({ name: "reranker" });
 * log.info({ topK: 5 }, "reranked candidates");
 * ```
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level: resolveLevel(opts.level),
    base: { service: opts.name, ...(opts.base ?? {}) },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (resolvePretty(opts.pretty)) {
    const stream = pretty({
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname,service",
      messageFormat: "[{service}] {msg}",
    });
    return pino(options, stream);
  }

  return pino(options);
}
