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

const g = globalThis as unknown as { __avnQueue?: Queue | null };

function queue(): Queue | null {
  if (g.__avnQueue !== undefined) return g.__avnQueue;
  const url = getConfig().REDIS_URL;
  if (!url) return (g.__avnQueue = null);
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  connection.on('error', () => undefined);
  g.__avnQueue = new Queue(JOB_QUEUE, { connection });
  return g.__avnQueue;
}

export interface EnqueueOptions {
  /** Tests: run to completion before returning. */
  inline?: boolean;
}

export async function enqueue(
  kind: JobKind,
  payload: JobPayload,
  options: EnqueueOptions = {},
): Promise<void> {
  const inline = options.inline ?? getConfig().NODE_ENV === 'test';
  const q = inline ? null : queue();
  if (q) {
    await q.add(kind, payload, {
      jobId: `${kind}:${payload.jobId}`,
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
  g.__avnQueue = undefined;
}
