import { randomUUID } from 'node:crypto';

import { getConfig } from '@avn-cms/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Background jobs (DEVELOPMENT_PHASES: imports and exports never run inside a request).
 * With Redis the job goes to the BullMQ queue the worker consumes. Without Redis (local dev,
 * tests) it runs in this process after the response — still off the request path, but only
 * one process does the work. Production must run the worker (docs/DEPLOYMENT.md).
 */
export const JOB_QUEUE = 'avn-jobs';

export type JobKind = 'import.validate' | 'import.run' | 'export.run' | 'document.scan' | 'automation.run';
export interface JobPayload {
  tenantId: string;
  jobId: string;
}

type Handler = (kind: JobKind, payload: JobPayload) => Promise<unknown>;
let localHandler: Handler | undefined;

/** The job runner registers itself here (avoids an import cycle with the processors). */
export function registerLocalHandler(handler: Handler): void {
  localHandler = handler;
}

const g = globalThis as unknown as { __avnQueue?: Queue | null; __avnQueueRedis?: Redis };

function queue(): Queue | null {
  if (g.__avnQueue !== undefined) return g.__avnQueue;
  const url = getConfig().REDIS_URL;
  if (!url) return (g.__avnQueue = null);
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  connection.on('error', () => undefined);
  g.__avnQueueRedis = connection;
  g.__avnQueue = new Queue(JOB_QUEUE, { connection });
  return g.__avnQueue;
}

/**
 * How long a request waits for the queue to take a job. With Redis unreachable BullMQ never gives
 * up (it keeps waiting for the connection), so without a limit the request would hang instead of
 * failing, and its caller could not put the job back.
 */
export const ENQUEUE_TIMEOUT_MS = 10_000;

export interface EnqueueOptions {
  /**
   * Run to completion before returning. Defaults to true in tests *without* REDIS_URL (the
   * normal test setup removes it); a test that sets REDIS_URL asks for the real queue.
   */
  inline?: boolean;
  /** Give up on the queue after this long (default ENQUEUE_TIMEOUT_MS). */
  timeoutMs?: number;
}

export async function enqueue(
  kind: JobKind,
  payload: JobPayload,
  options: EnqueueOptions = {},
): Promise<void> {
  const config = getConfig();
  const inline = options.inline ?? (config.NODE_ENV === 'test' && !config.REDIS_URL);
  const q = inline ? null : queue();
  if (q) {
    const added = q.add(kind, payload, {
      // BullMQ refuses ids containing ":" and silently drops an add whose id still exists (finished
      // jobs are kept for days), so a re-queued import — "check again", start over — needs a new one.
      // Double delivery is harmless anyway: the runners claim the job row (QUEUED → RUNNING).
      jobId: `${kind}-${payload.jobId}-${randomUUID()}`,
      attempts: 1,
      removeOnComplete: { age: 7 * 86_400, count: 1000 },
      removeOnFail: { age: 30 * 86_400 },
    });
    // If the timeout wins, the add may still finish later (Redis came back). The job row has been
    // put back by then, so the worker's claim finds nothing to take and the job is a no-op.
    added.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('The job queue did not answer in time (is Redis reachable?).')),
        options.timeoutMs ?? ENQUEUE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([added, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  if (!localHandler) throw new Error('No job handler registered');
  const handler = localHandler;
  if (inline) {
    await handler(kind, payload);
    return;
  }
  const running = new Promise<void>((resolve) => {
    setImmediate(() => {
      handler(kind, payload)
        .catch((err: unknown) =>
          console.error(
            JSON.stringify({
              level: 'error',
              msg: 'in-process job failed',
              kind,
              jobId: payload.jobId,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        )
        .finally(resolve);
    });
  });
  inProcessJobs.add(running);
  void running.finally(() => inProcessJobs.delete(running));
}

const inProcessJobs = new Set<Promise<void>>();

/** Waits for jobs started in this process (the no-Redis fallback) to finish, including any they start. */
export async function drainInProcessJobs(): Promise<void> {
  while (inProcessJobs.size > 0) await Promise.all([...inProcessJobs]);
}

/**
 * How many background jobs wait, run, are delayed or have failed (the failed ones are kept for 30 days).
 * Null without Redis, or when it does not answer within `timeoutMs`: a monitoring call never hangs.
 */
export async function queueDepth(
  timeoutMs = 1500,
): Promise<{ waiting: number; active: number; delayed: number; failed: number } | null> {
  const q = queue();
  if (!q) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const counts = await Promise.race([
      q.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!counts) return null;
    return {
      waiting: counts['waiting'] ?? 0,
      active: counts['active'] ?? 0,
      delayed: counts['delayed'] ?? 0,
      failed: counts['failed'] ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function closeQueue(): Promise<void> {
  if (g.__avnQueue) await g.__avnQueue.close().catch(() => undefined);
  // BullMQ leaves a connection it was handed open.
  if (g.__avnQueueRedis) await g.__avnQueueRedis.quit().catch(() => undefined);
  g.__avnQueue = undefined;
  g.__avnQueueRedis = undefined;
}
