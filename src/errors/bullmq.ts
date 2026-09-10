import { captureError } from "./capture.js";
import { isEnabled } from "./config.js";

/*
 * Structural adapter over each service's jobs-manager, mirroring
 * metrics/bullmq.ts. Callback params are `any` on purpose: the concrete
 * managers type `job`/`queue` more specifically and function-parameter
 * contravariance would otherwise reject an otherwise-compatible manager.
 */
interface JobsManagerLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onFailed?: (cb: (job: any, err: any) => void) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onAdded?: (cb: (job: any, queue: any) => void) => void;
}

/**
 * Report failed BullMQ jobs as issues.
 *
 *   import { captureBullmqErrors } from "@neuralsearchindex/sdk-node/errors";
 *   captureBullmqErrors(jobsManager);
 *
 * This is the half of error tracking that a request-scoped handler cannot
 * reach, and the half that matters most here: a Fastify 500 is visible to a
 * caller, whereas a worker that fails every job looks perfectly healthy from
 * outside — /health still answers, the pod never restarts, and the only
 * symptom is work not getting done. engine-jobs, scraper-jobs and
 * ingestion-pipeline-jobs reported nothing at all before this.
 *
 * Grouping is by QUEUE and error message, not by job id — otherwise a queue
 * failing a thousand jobs for one reason produces a thousand issues and the
 * console becomes unreadable at the exact moment you need it.
 */
export function captureBullmqErrors(jobsManager: JobsManagerLike): void {
  if (!isEnabled()) return;
  if (typeof jobsManager.onFailed !== "function") {
    console.warn(
      "[nsi-errors] jobs manager exposes no onFailed() — failed jobs will NOT " +
        "be reported. This is a wiring bug, not a configuration choice.",
    );
    return;
  }

  jobsManager.onFailed((job, err) => {
    const queue: string = job?.queueName ?? job?.queue?.name ?? "unknown";
    const attempts: number = job?.attemptsMade ?? 0;
    const maxAttempts: number = job?.opts?.attempts ?? 1;

    captureError(err, {
      tags: {
        queue,
        job_name: job?.name,
        // A job that will be retried is not yet a failure. Tagging lets you
        // filter to terminal failures without losing the retry history.
        terminal: attempts >= maxAttempts,
      },
      context: {
        jobId: job?.id,
        attemptsMade: attempts,
        maxAttempts,
        // Job data can be large and can contain scraped payloads; a shallow
        // key list is enough to reproduce without shipping the contents.
        dataKeys: job?.data && typeof job.data === "object" ? Object.keys(job.data) : undefined,
      },
      fingerprint: ["bullmq", queue, "{{ default }}"],
    });
  });
}
