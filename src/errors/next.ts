/**
 * Error-tracking config for the Next.js apps (web, admin).
 *
 * Separate from the rest of this module because Next.js needs
 * `@sentry/nextjs`, not `@sentry/node` — it wraps the build to upload source
 * maps and instruments both runtimes. This file therefore imports NO
 * `@sentry/*` package at all; it only computes options the apps hand to their
 * own SDK, so it is safe to import from either runtime.
 *
 * ── The build-time freeze, which this exists to prevent ────────────────────
 *
 * The Sentry Next.js docs tell you to put the DSN in `NEXT_PUBLIC_SENTRY_DSN`.
 * Do not. Next inlines every `NEXT_PUBLIC_*` into the client bundle at BUILD
 * time, and our DSN's host is the gateway LoadBalancer IP, which does not
 * exist when the image is built — so the baked value could only ever be the
 * localhost dev default. The platform has now hit this exact bug twice: the
 * admin sidebar frozen at *.127.0.0.1.nip.io (chart 0.6.5) and the analytics
 * host (chart 0.8.0).
 *
 * "Read it on the server" is NOT sufficient on its own, either: a server
 * component under `generateStaticParams` is PRERENDERED AT BUILD, so its
 * `process.env` read freezes identically. `x-nextjs-prerender: 1` on the
 * response is how you spot that variant.
 *
 * The reliable shape is a ROUTE HANDLER — `app/api/observability/config` —
 * which is evaluated per request, fetched by the client before it initialises.
 * That is what `readBrowserConfig` is for.
 */

/** The shape the route handler returns and the browser consumes. */
export interface BrowserErrorConfig {
  /** Empty ⇒ the client must not initialise. Normal before bootstrap has run. */
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate: number;
  /** Browser session replay on errors. Independent of server profiling. */
  replaysOnErrorSampleRate: number;
}

function rate(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * SERVER-ONLY. Call this from a route handler (never from a page, a layout, or
 * anything reachable by `generateStaticParams`) and return the result as JSON.
 *
 * Reads SENTRY_BROWSER_DSN — the same GlitchTip project as the server-side
 * SENTRY_DSN, but addressed through the PUBLIC host, because the in-cluster
 * Service name means nothing to a browser. The chart wires both.
 */
export function readBrowserConfig(env: NodeJS.ProcessEnv = process.env): BrowserErrorConfig {
  return {
    dsn: env.SENTRY_BROWSER_DSN ?? "",
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
    release: env.SENTRY_RELEASE || undefined,
    tracesSampleRate: rate(env.SENTRY_TRACES_SAMPLE_RATE),
    replaysOnErrorSampleRate: rate(env.SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE, 1),
  };
}

/**
 * SERVER runtime options for `@sentry/nextjs` — used by instrumentation.ts,
 * which runs per process and is not subject to the build-time freeze, so it
 * can read the in-cluster SENTRY_DSN directly.
 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    dsn: env.SENTRY_DSN ?? "",
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
    release: env.SENTRY_RELEASE || undefined,
    tracesSampleRate: rate(env.SENTRY_TRACES_SAMPLE_RATE),
    // Deliberately not forwarded from the shared env: `includeLocalVariables`
    // in a Next server runtime would capture request bodies and session
    // objects wholesale.
  };
}
