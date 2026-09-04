import fp from "fastify-plugin";
import { client, register } from "./registry.js";

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Fastify plugin: serves `GET /metrics` (Prometheus text) and records an
 * `http_request_duration_seconds` histogram for every request (labelled by
 * method / route template / status). Registered with fastify-plugin so the
 * onResponse hook applies globally (not just this encapsulated context).
 *
 *   import { metricsPlugin } from "@neuralsearchindex/sdk-node/metrics";
 *   await app.register(metricsPlugin);
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const metricsPlugin = fp(async (app: any) => {
  app.get("/metrics", async (_req: unknown, reply: any) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });
  app.addHook("onResponse", async (req: any, reply: any) => {
    if (req.url === "/metrics") return;
    const route: string = req.routeOptions?.url ?? req.routerPath ?? req.url ?? "unknown";
    httpDuration.observe(
      { method: req.method, route, status_code: reply.statusCode },
      (reply.elapsedTime ?? 0) / 1000,
    );
  });
}, { name: "nsi-metrics" });
