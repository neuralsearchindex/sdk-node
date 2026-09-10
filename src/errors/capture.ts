import * as Sentry from "@sentry/node";

import { isEnabled } from "./config.js";

export type Tags = Record<string, string | number | boolean | undefined>;

export interface CaptureOptions {
  /** Indexed, searchable, low-cardinality: queue name, provider id, lane. */
  tags?: Tags;
  /** Not indexed — the payload you want when reading the issue. */
  context?: Record<string, unknown>;
  /**
   * Overrides the automatic grouping. Use when the default fingerprint would
   * split one problem across hundreds of issues (a message containing an id,
   * a URL, a timestamp) — or, occasionally, to force a split.
   */
  fingerprint?: string[];
  level?: "fatal" | "error" | "warning" | "info" | "debug";
}

/**
 * Report an error that was CAUGHT. Returns the event id, or undefined when
 * tracking is off.
 *
 * Deliberately never throws: an error reporter that can itself fail turns a
 * handled error into an unhandled one, in the exact code path that was already
 * going wrong.
 */
export function captureError(err: unknown, opts: CaptureOptions = {}): string | undefined {
  if (!isEnabled()) return undefined;
  try {
    return Sentry.withScope((scope) => {
      if (opts.level) scope.setLevel(opts.level);
      if (opts.fingerprint) scope.setFingerprint(opts.fingerprint);
      for (const [k, v] of Object.entries(opts.tags ?? {})) {
        if (v !== undefined) scope.setTag(k, String(v));
      }
      if (opts.context) scope.setContext("details", opts.context);
      return err instanceof Error
        ? Sentry.captureException(err)
        : // A thrown non-Error has no stack, so it would otherwise group every
          // occurrence together under one useless issue. Wrapping gives it a
          // stack from the throw site.
          Sentry.captureException(new Error(typeof err === "string" ? err : JSON.stringify(err)));
    });
  } catch {
    return undefined;
  }
}

/** Attach the current user to subsequent events on this scope. */
export function setErrorUser(user: { id?: string; email?: string } | null): void {
  if (!isEnabled()) return;
  try {
    Sentry.setUser(user);
  } catch {
    /* never let telemetry break a request */
  }
}

/** Breadcrumb — shows up as timeline context on whatever error comes next. */
export function addErrorBreadcrumb(message: string, data?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  try {
    Sentry.addBreadcrumb({ message, data, level: "info" });
  } catch {
    /* ditto */
  }
}
