/**
 * Runtime configuration for error tracking, read from the environment the Helm
 * chart injects (`errorTracking` in values → templates/_component.tpl and the
 * shared ConfigMap). Kept free of any `@sentry/*` import so the Next.js apps —
 * which must use `@sentry/nextjs`, not `@sentry/node` — can share it.
 */

/** Env contract. Every one of these is set by the umbrella chart. */
export interface ErrorTrackingConfig {
  /**
   * Sentry-protocol DSN pointing at this service's own GlitchTip project.
   * EMPTY is the normal state on a cluster whose bootstrap has not run yet —
   * the chart's secretKeyRef is `optional`, precisely so a missing DSN leaves
   * reporting off instead of crash-looping every pod. Callers must treat empty
   * as "disabled", never as an error.
   */
  dsn: string;
  /** Component name — `engine`, `engine-jobs`, `polish-vehicles-catalog`, … */
  service: string;
  /**
   * `<component>@<image tag>`. Must match the release the CI source-map upload
   * used, or a minified stack trace stays minified.
   */
  release?: string;
  environment: string;
  tracesSampleRate: number;
  profilesSampleRate: number;
  /**
   * Ship stack-frame locals. Off unless explicitly enabled: locals routinely
   * hold tokens, PII and request bodies, and the event store is a different
   * trust boundary from the process that crashed.
   */
  includeLocalVariables: boolean;
  /**
   * Leave OpenTelemetry alone.
   *
   * The Sentry Node SDK installs its OWN OpenTelemetry TracerProvider. A
   * service that already runs a NodeSDK — `agents` does, for Langfuse — ends
   * up with two providers racing to register globally, and the loser's traces
   * vanish. Since Langfuse is the LLM tracing story there, Sentry defers:
   * errors still work, tracing stays with the provider that was already
   * doing the job.
   *
   * Not read from the environment. Whether a process owns its own tracer is a
   * property of the code, not of the deployment.
   */
  skipOpenTelemetrySetup: boolean;
}

/**
 * Parse a sample rate. Anything unparseable becomes 0 rather than 1: a typo in
 * a values file should cost nothing, not silently bill you for full tracing.
 */
function rate(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

function bool(raw: string | undefined): boolean {
  return raw === "true" || raw === "1";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ErrorTrackingConfig {
  return {
    dsn: env.SENTRY_DSN ?? "",
    service: env.SENTRY_SERVICE ?? env.SERVICE_NAME ?? "unknown",
    release: env.SENTRY_RELEASE || undefined,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
    tracesSampleRate: rate(env.SENTRY_TRACES_SAMPLE_RATE),
    profilesSampleRate: rate(env.SENTRY_PROFILES_SAMPLE_RATE),
    includeLocalVariables: bool(env.SENTRY_INCLUDE_LOCAL_VARIABLES),
    skipOpenTelemetrySetup: false,
  };
}

/** True when there is somewhere to send events. */
export function isEnabled(cfg: ErrorTrackingConfig = readConfig()): boolean {
  return cfg.dsn.trim().length > 0;
}
