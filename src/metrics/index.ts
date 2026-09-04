/**
 * Shared Prometheus metrics for NeuralSearchIndex services.
 *
 *  - `register` / `client`  — the shared prom-client registry (define custom
 *    domain metrics on it: nsi_ingestion_*, nsi_scrape_*, nsi_index_documents, …).
 *  - `metricsPlugin`        — Fastify plugin: GET /metrics + request-duration.
 *  - `startMetricsServer`   — standalone /metrics listener (workers, agents).
 *  - `collectBullmqMetrics` — queue depth + job duration/outcome gauges/counters.
 */
export { register, client } from "./registry.js";
export { metricsPlugin } from "./fastify.js";
export { startMetricsServer } from "./server.js";
export { collectBullmqMetrics } from "./bullmq.js";
