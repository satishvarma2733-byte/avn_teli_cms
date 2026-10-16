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

export type JobKind = 'import.validate' | 'import.run' | 'export.run';
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

export interface EnqueueOptions {
  /**
   * Run to completion before returning. Defaults to true in tests *without* REDIS_URL (the
   * normal test setup removes it); a test that sets REDIS_URL asks for the real queue.
   */
  inline?: boolean;
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
    await q.add(kind, payload, {
      // BullMQ refuses ids containing ":" and silently drops an add whose id still exists (finished
      // jobs are kept for days), so a re-queued import — "check again", start over — needs a new one.
      // Double delivery is harmless anyway: the runners claim the job row (QUEUED → RUNNING).
      jobId: `${kind}-${payload.jobId}-${randomUUID()}`,
      attempts: 1,
      removeOnComplete: { age: 7 * 86_400, count: 1000 },
      removeOnFail: { age: 30 * 86_400 },
    });
    return;
  }
  if (!localHandler) throw new Error('No job handler registered');
  const handler = localHandler;
  if (inline) {
    await handler(kind, payload);
    return;
  }
  setImmediate(() => {
    handler(kind, payload).catch((err: unknown) =>
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'in-process job failed',
          kind,
          jobId: payload.jobId,
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  });
}

export async function closeQueue(): Promise<void> {
  if (g.__avnQueue) await g.__avnQueue.close().catch(() => undefined);
  // BullMQ leaves a connection it was handed open.
  if (g.__avnQueueRedis) await g.__avnQueueRedis.quit().catch(() => undefined);
  g.__avnQueue = undefined;
  g.__avnQueueRedis = undefined;
}
