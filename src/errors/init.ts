import { createRequire } from "node:module";

import * as Sentry from "@sentry/node";

import { type ErrorTrackingConfig, isEnabled, readConfig } from "./config.js";

/*
 * This package is ESM ("type": "module"), so bare `require` is NOT in scope —
 * referencing it throws "require is not defined" at runtime, which the guard
 * below would then report as "profiling could not be loaded". That is exactly
 * what happened on the first cut of this file: profiling was off on every
 * service and the only evidence was one warning line at boot. Tested under
 * `node --input-type=module`; a CJS `require()` of this same file leaks a
 * working `require` into scope and hides the bug.
 */
const requireOptional = createRequire(import.meta.url);

let started = false;

/**
 * Initialise error tracking for a Node service.
 *
 * ⚠️  ORDERING. Sentry's automatic instrumentation works by patching modules
 * (http, pg, ioredis, …) as they are required, so this must run BEFORE the
 * application imports any of them. ES import statements are hoisted, so
 * calling this from inside your entrypoint is TOO LATE — by then every import
 * in that file has already been evaluated. Import the side-effect module as
 * the very first line instead:
 *
 *     import "@neuralsearchindex/sdk-node/errors/register";
 *     // …everything else below
 *
 * Nothing warns you when you get this wrong: errors you capture by hand still
 * arrive, only the automatic breadcrumbs and spans go quietly missing, which
 * looks like "tracing does not work here" rather than a misordered import.
 *
 * Returns whether tracking actually started, so a caller can log the outcome.
 * A DSN-less environment is a normal, expected no-op — see config.ts.
 */
export function initErrors(overrides: Partial<ErrorTrackingConfig> = {}): boolean {
  if (started) return true;

  const cfg = { ...readConfig(), ...overrides };
  if (!isEnabled(cfg)) return false;

  const integrations = [Sentry.extraErrorDataIntegration()];

  if (cfg.profilesSampleRate > 0) {
    // Native module (@sentry/profiling-node ships prebuilt binaries). Loaded
    // lazily and optionally so a service that has not added the dependency —
    // or an image whose platform has no prebuild — still gets ERRORS, which
    // are the point, instead of failing to boot over a profiler.
    //
    // The failure is announced rather than swallowed: a profiles rate that is
    // configured but not in effect is exactly the sort of thing that gets
    // trusted for months.
    try {
      const { nodeProfilingIntegration } = requireOptional("@sentry/profiling-node");
      integrations.push(nodeProfilingIntegration());
    } catch (err) {
      console.warn(
        `[nsi-errors] SENTRY_PROFILES_SAMPLE_RATE=${cfg.profilesSampleRate} but ` +
          `@sentry/profiling-node could not be loaded — profiling is OFF for ` +
          `${cfg.service}. Errors and tracing are unaffected. (${(err as Error).message})`,
      );
    }
  }

  Sentry.init({
    dsn: cfg.dsn,
    environment: cfg.environment,
    release: cfg.release,
    integrations,
    tracesSampleRate: cfg.tracesSampleRate,
    profilesSampleRate: cfg.profilesSampleRate,
    includeLocalVariables: cfg.includeLocalVariables,
    skipOpenTelemetrySetup: cfg.skipOpenTelemetrySetup,
  });

  // Tag every event with the component name. The DSN already routes to this
  // service's project, but the tag survives an operator consolidating projects
  // later, and it makes cross-project search possible.
  Sentry.setTag("service", cfg.service);

  started = true;
  return true;
}

/**
 * Flush buffered events and shut the client down. Call from the same graceful
 * shutdown path that closes the server: events are batched, so a process that
 * exits promptly on SIGTERM otherwise drops the last few — including, quite
 * often, the error that caused the shutdown.
 */
export async function closeErrors(timeoutMs = 2000): Promise<void> {
  if (!started) return;
  await Sentry.close(timeoutMs);
}
