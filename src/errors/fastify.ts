import * as Sentry from "@sentry/node";
import fp from "fastify-plugin";

import { isEnabled } from "./config.js";

/**
 * Fastify plugin: reports unhandled route errors to GlitchTip.
 *
 *   import { errorsPlugin } from "@neuralsearchindex/sdk-node/errors";
 *   await app.register(errorsPlugin);
 *
 * Registered with fastify-plugin so the hook applies globally rather than to
 * one encapsulated context — the same reason `metricsPlugin` does.
 *
 * Note this only ATTACHES the handler; `initErrors()` must already have run
 * (see errors/register). Registering the plugin without it is a silent no-op,
 * which is why the plugin is a no-op by design when tracking is off rather
 * than pretending to work.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const errorsPlugin = fp(async (app: any) => {
  if (!isEnabled()) return;

  Sentry.setupFastifyErrorHandler(app);

  // Route template, not the concrete URL: `/listings/:id` rather than
  // `/listings/8f21…`. Without it every id produces its own transaction name
  // and the grouping is worthless.
  app.addHook("onRequest", async (req: any) => {
    const route: string | undefined = req.routeOptions?.url ?? req.routerPath;
    if (route) Sentry.getCurrentScope().setTransactionName(`${req.method} ${route}`);
  });

  // Health and metrics endpoints are polled every few seconds by kubelet and
  // Prometheus. Left in, their breadcrumbs crowd out everything that actually
  // preceded an error.
  app.addHook("onResponse", async (req: any) => {
    if (req.url === "/metrics" || req.url === "/health" || req.url === "/ok") return;
  });
}, { name: "nsi-errors" });
