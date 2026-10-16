import { JOB_QUEUE, processJob, type JobKind, type JobPayload } from '@avn-cms/core';
import { Worker, type ConnectionOptions, type Queue } from 'bullmq';

import {
  documentMaintenanceAllTenants,
  expiredFilesSweepAllTenants,
  overdueSweepAllTenants,
  stuckJobsSweepAllTenants,
} from './jobs';

/**
 * The BullMQ side of the worker, kept apart from index.ts (which boots the process and owns
 * shutdown) so tests can start the same workers against a real Redis.
 *  - `avn-system`: scheduled system jobs. Repeatable jobs are de-duplicated by BullMQ, so several
 *    workers can run safely.
 *  - `avn-jobs`: imports and exports requested from the web app.
 */
export const SYSTEM_QUEUE = 'avn-system';

/** Name → how often it runs. */
export const SYSTEM_JOBS = {
  'overdue-sweep': 5 * 60_000,
  'expired-files': 60 * 60_000,
  // Well under the 10 minutes of silence after which a claimed import/export counts as abandoned.
  'stuck-jobs': 2 * 60_000,
  // Re-queues document scans that never ran, removes blocked/deleted files, drops abandoned uploads.
  'document-maintenance': 2 * 60_000,
} as const;
export type SystemJobName = keyof typeof SYSTEM_JOBS;

export async function scheduleSystemJobs(queue: Queue): Promise<void> {
  for (const [name, every] of Object.entries(SYSTEM_JOBS)) {
    await queue.upsertJobScheduler(name, { every }, { name });
  }
}

export async function processSystemJob(name: string) {
  switch (name) {
    case 'overdue-sweep':
      return overdueSweepAllTenants();
    case 'expired-files':
      return expiredFilesSweepAllTenants();
    case 'stuck-jobs':
      return stuckJobsSweepAllTenants();
    case 'document-maintenance':
      return documentMaintenanceAllTenants();
    default:
      throw new Error(`Unknown job ${name}`);
  }
}

export function createSystemWorker(connection: ConnectionOptions): Worker {
  return new Worker(SYSTEM_QUEUE, async (job) => processSystemJob(job.name), { connection, concurrency: 1 });
}

export function createJobsWorker(connection: ConnectionOptions): Worker {
  return new Worker(
    JOB_QUEUE,
    async (job) => processJob(job.name as JobKind, job.data as JobPayload),
    // Imports/exports are heavy and run one transaction batch at a time; two in parallel is plenty.
    { connection, concurrency: 2, lockDuration: 5 * 60_000 },
  );
}
