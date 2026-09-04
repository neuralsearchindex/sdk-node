import client from "prom-client";

/**
 * Shared Prometheus registry for every NeuralSearchIndex service. Import this and
 * register counters/gauges/histograms on it; the Fastify plugin / standalone
 * server below expose `register.metrics()` at `/metrics`.
 *
 * `SERVICE_NAME` (env) becomes a default label so multi-service dashboards can
 * split by service. `collectDefaultMetrics` adds Node process/GC/event-loop/heap.
 */
export { client };
export const register = new client.Registry();
register.setDefaultLabels({ service: process.env.SERVICE_NAME ?? "unknown" });
client.collectDefaultMetrics({ register });
