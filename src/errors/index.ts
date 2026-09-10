/**
 * Error tracking for NeuralSearchIndex services — exceptions and stack traces
 * grouped into issues, backed by the GlitchTip deployed with the platform
 * chart (Sentry's wire protocol, so these are the stock @sentry/* SDKs and the
 * DSN can be repointed at Sentry itself with no code change).
 *
 * This is NOT the metrics module's job and NOT the log stack's job. Those
 * answer "how many, how slow" and "what did it print". This answers "what
 * broke, where in the code, how often, since which release, and is it fixed".
 *
 * Wiring a service, in order:
 *
 *   1. FIRST line of the entrypoint — ordering is load-bearing, see init.ts:
 *        import "@neuralsearchindex/sdk-node/errors/register";
 *   2. Fastify services:
 *        await app.register(errorsPlugin);
 *   3. BullMQ workers:
 *        captureBullmqErrors(jobsManager);
 *   4. Graceful shutdown:
 *        await closeErrors();
 *
 * Every entry point is a no-op when SENTRY_DSN is unset, which is the normal
 * state before the cluster's GlitchTip bootstrap has run.
 */
export { type ErrorTrackingConfig, isEnabled, readConfig } from "./config.js";
export { closeErrors, initErrors } from "./init.js";
export { type CaptureOptions, addErrorBreadcrumb, captureError, setErrorUser } from "./capture.js";
export { errorsPlugin } from "./fastify.js";
export { captureBullmqErrors } from "./bullmq.js";
