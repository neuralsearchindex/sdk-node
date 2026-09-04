import http from "node:http";
import { register } from "./registry.js";

/**
 * Standalone `/metrics` HTTP server for processes with no Fastify app — the
 * BullMQ worker entrypoints (`-jobs`) and the LangGraph `agents` server. Serves
 * `GET /metrics` (Prometheus text) and `GET /health` on a dedicated port.
 *
 *   import { startMetricsServer } from "@neuralsearchindex/sdk-node/metrics";
 *   const srv = startMetricsServer(Number(process.env.METRICS_PORT ?? 9090));
 *   // on shutdown: srv.close();
 */
export function startMetricsServer(
  port: number = Number(process.env.METRICS_PORT ?? 9090),
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/metrics")) {
      register
        .metrics()
        .then((body) => {
          res.setHeader("Content-Type", register.contentType);
          res.end(body);
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(String(err));
        });
    } else if (req.url?.startsWith("/health")) {
      res.end("ok");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(port);
  server.unref?.(); // don't keep the process alive just for metrics
  return server;
}
