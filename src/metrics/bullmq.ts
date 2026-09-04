import { client, register } from "./registry.js";

const STATES = ["waiting", "active", "completed", "failed", "delayed", "paused"] as const;

interface QueueLike {
  name: string;
  getJobCounts: (...states: string[]) => Promise<Record<string, number>>;
}

interface JobsManagerLike {
  /** Fires for every registered BullMQ queue (engine/scraper/ingestion jobs-manager). */
  onAdded: (cb: (job: unknown, queue: QueueLike) => void) => void;
  /** Wraps every processor — same seam as track-execution-time.middleware.ts. */
  addMiddleware?: (
    fn: (ctx: { queueName: string }, next: () => Promise<void>) => Promise<void>,
  ) => void;
}

/**
 * BullMQ metrics on the shared registry. Emits (feeding the "BullMQ Overview"
 * dashboard, grafana.com/25072):
 *   - bullmq_queue_jobs{queue,state}      gauge, sampled at scrape time
 *   - bullmq_job_duration_seconds{queue}  histogram
 *   - bullmq_completed_total{queue}       counter
 *   - bullmq_failed_total{queue}          counter
 */
export function collectBullmqMetrics(jobsManager: JobsManagerLike): void {
  const queues = new Map<string, QueueLike>();
  jobsManager.onAdded((_job, queue) => queues.set(queue.name, queue));

  new client.Gauge({
    name: "bullmq_queue_jobs",
    help: "BullMQ jobs by queue and state",
    labelNames: ["queue", "state"],
    registers: [register],
    async collect() {
      for (const [name, q] of queues) {
        try {
          const counts = await q.getJobCounts(...STATES);
          for (const s of STATES) this.set({ queue: name, state: s }, counts[s] ?? 0);
        } catch {
          /* a transient redis blip shouldn't fail the scrape */
        }
      }
    },
  });

  const duration = new client.Histogram({
    name: "bullmq_job_duration_seconds",
    help: "BullMQ job processing duration in seconds",
    labelNames: ["queue"],
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300],
    registers: [register],
  });
  const completed = new client.Counter({
    name: "bullmq_completed_total", help: "BullMQ jobs completed", labelNames: ["queue"], registers: [register],
  });
  const failed = new client.Counter({
    name: "bullmq_failed_total", help: "BullMQ jobs failed", labelNames: ["queue"], registers: [register],
  });

  jobsManager.addMiddleware?.(async (ctx, next) => {
    const end = duration.startTimer({ queue: ctx.queueName });
    try {
      await next();
      completed.inc({ queue: ctx.queueName });
    } catch (e) {
      failed.inc({ queue: ctx.queueName });
      throw e;
    } finally {
      end();
    }
  });
}
