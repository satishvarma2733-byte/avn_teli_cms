import type { Prisma, TenantDb } from '@avn-cms/db';

import type { ImportResult } from '../imports/import.runner';

/**
 * Recovery of cut-off background jobs. A worker that dies mid-run (crash, deploy, out of
 * memory) leaves its job VALIDATING or RUNNING for ever: BullMQ may hand the job to another
 * worker, but the claim (QUEUED → RUNNING) has already been taken, so nothing happens.
 *
 * Every claimed job carries a heartbeat (`heartbeat_at`): set when it is claimed and renewed after
 * each batch (imports) or page (exports). A claimed job whose heartbeat is older than
 * STALE_AFTER_MS is marked FAILED with a plain message, and the person is offered a way to start
 * over. Rows an import had already saved stay; the next run recognises them by mobile number.
 */

/**
 * Longer than any silent stretch of a healthy run: a batch transaction is cut off after 2 minutes
 * and BullMQ's own lock lasts 5. Shorter would risk failing a job that is only slow.
 */
export const STALE_AFTER_MS = 10 * 60_000;

/**
 * Thrown inside a runner when its job was failed by recovery while it was still working (it was
 * only slow, not dead). The runner stops quietly and leaves the job as recovery left it.
 */
export class JobSupersededError extends Error {
  constructor() {
    super('The job was marked failed by recovery while it was still running.');
    this.name = 'JobSupersededError';
  }
}

export interface RecoveryResult {
  imports: number;
  exports: number;
}

const number = (n: number) => n.toLocaleString('en-IN');

function importMessage(running: boolean, result: ImportResult): string {
  if (!running) return 'The check stopped before it finished (the server was probably restarted).';
  // Progress is written after each batch, so the batch in flight when it stopped may be saved too.
  const progress = result.processed
    ? `At least ${number(result.processed)} of ${number(result.total ?? result.processed)} rows had been processed.`
    : 'Some rows may have been saved before it stopped.';
  return `The import stopped before it finished (the server was probably restarted). ${progress}`;
}

const EXPORT_MESSAGE =
  'The export stopped before it finished (the server was probably restarted). Request it again.';

/**
 * Marks claimed jobs that have shown no sign of life since `now - staleAfterMs` as FAILED.
 * Runs inside one workspace (withTenant); the worker calls it for every workspace.
 */
export async function failStuckJobs(
  db: TenantDb,
  now = new Date(),
  staleAfterMs = STALE_AFTER_MS,
): Promise<RecoveryResult> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  // Jobs from before heartbeats existed have none: fall back to when they were created.
  const silent = {
    OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, createdAt: { lt: cutoff } }],
  };
  let imports = 0;
  let exports = 0;

  const importJobs = await db.importJob.findMany({
    where: { status: { in: ['VALIDATING', 'RUNNING'] }, ...silent },
    select: { id: true, status: true, result: true },
  });
  for (const job of importJobs) {
    const running = job.status === 'RUNNING';
    const result = (job.result ?? {}) as ImportResult;
    const failed: ImportResult = {
      ...(running ? result : {}),
      error: importMessage(running, result),
      failedIn: running ? 'run' : 'check',
    };
    // Conditional on the same state, so a job that woke up in the meantime is left alone.
    const res = await db.importJob.updateMany({
      where: { id: job.id, status: job.status, ...silent },
      data: { status: 'FAILED', result: failed as Prisma.InputJsonValue, finishedAt: now },
    });
    imports += res.count;
  }

  const exportJobs = await db.exportJob.findMany({
    where: { status: 'RUNNING', ...silent },
    select: { id: true },
  });
  for (const job of exportJobs) {
    const res = await db.exportJob.updateMany({
      where: { id: job.id, status: 'RUNNING', ...silent },
      data: { status: 'FAILED', result: { error: EXPORT_MESSAGE }, finishedAt: now },
    });
    exports += res.count;
  }
  return { imports, exports };
}
