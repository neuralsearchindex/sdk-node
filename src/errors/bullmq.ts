import { captureError } from "./capture.js";
import { isEnabled } from "./config.js";

/*
 * Structural adapter over each service's jobs-manager, mirroring
 * metrics/bullmq.ts. Callback params are `any` on purpose: the concrete
 * managers (IJobsManager in engine/scraper/ingestion) type `job` more
 * specifically, and function-parameter contravariance would otherwise reject
 * an otherwise-compatible manager.
 */
interface JobsManagerLike {
  /**
   * Wraps every processor. This — not an event listener — is the hook the
   * platform's managers actually expose; `collectBullmqMetrics` uses the same
   * one. An earlier cut of this file expected an `onFailed` event that no
   * manager has, so it warned once at boot and then reported nothing.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addMiddleware?: (fn: (job: any, next: (job: any) => Promise<any>) => Promise<any>) => void;
}

/**
 * Report failed BullMQ jobs as issues.
 *
 *   import { captureBullmqErrors } from "@neuralsearchindex/sdk-node/errors";
 *   captureBullmqErrors(jobsManager);
 *
 * This is the half of error tracking a request-scoped handler cannot reach,
 * and the half that matters most here: a Fastify 500 is visible to its caller,
 * whereas a worker that fails every job looks perfectly healthy from outside
 * — /health still answers, the pod never restarts, and the only symptom is
 * work not getting done. engine-jobs, scraper-jobs and
 * ingestion-pipeline-jobs reported nothing at all before this.
 *
 * Grouping is by QUEUE and error message, not by job id: a queue failing a
 * thousand jobs for one reason should be one issue, not a thousand.
 */
export function captureBullmqErrors(jobsManager: JobsManagerLike): void {
  if (!isEnabled()) return;

  if (typeof jobsManager.addMiddleware !== "function") {
    // Loud, because the alternative is a worker that looks instrumented and
    // silently is not — the failure mode this whole module exists to remove.
    console.warn(
      "[nsi-errors] jobs manager exposes no addMiddleware() — failed jobs will " +
        "NOT be reported. This is a wiring bug, not a configuration choice.",
    );
    return;
  }

  jobsManager.addMiddleware(async (job, next) => {
    try {
      return await next(job);
    } catch (err) {
      const queue: string = job?.queueName ?? "unknown";
      const attempts: number = job?.attemptsMade ?? 0;
      // attemptsMade is incremented AFTER the processor returns, so inside the
      // middleware it is still the count of PREVIOUS attempts — this one makes
      // attempts + 1.
      const maxAttempts: number = job?.opts?.attempts ?? 1;

      captureError(err, {
        tags: {
          queue,
          job_name: job?.name,
          // A job that will be retried is not yet a failure. Without this tag
          // every count is inflated by the backoff factor.
          terminal: attempts + 1 >= maxAttempts,
        },
        context: {
          jobId: job?.id,
          attemptsMade: attempts + 1,
          maxAttempts,
          // Job payloads can be large and can carry scraped content; a shallow
          // key list is enough to reproduce without shipping the contents into
          // a different trust boundary.
          dataKeys:
            job?.data && typeof job.data === "object" ? Object.keys(job.data) : undefined,
        },
        fingerprint: ["bullmq", queue, "{{ default }}"],
      });
      throw err; // the manager and BullMQ still need the failure
    }
  });
}
