import { getConfig } from '@avn-cms/config';
import { JOB_QUEUE, processJob, type JobKind, type JobPayload } from '@avn-cms/core';
import { disconnectAll } from '@avn-cms/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { expiredFilesSweepAllTenants, overdueSweepAllTenants } from './jobs';

/**
 * aVn CMS worker. Two queues on one Redis:
 *  - `avn-system`: scheduled system jobs (overdue sweep every 5 min, expired-file cleanup hourly);
 *    repeatable jobs are de-duplicated by BullMQ, so several workers can run safely.
 *  - `avn-jobs`: imports and exports requested from the web app.
 */
const config = getConfig();
if (!config.REDIS_URL) throw new Error('REDIS_URL is required for the worker');

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const SYSTEM_QUEUE = 'avn-system';

const system = new Queue(SYSTEM_QUEUE, { connection });
await system.upsertJobScheduler('overdue-sweep', { every: 5 * 60_000 }, { name: 'overdue-sweep' });
await system.upsertJobScheduler('expired-files', { every: 60 * 60_000 }, { name: 'expired-files' });

const systemWorker = new Worker(
  SYSTEM_QUEUE,
  async (job) => {
    if (job.name === 'overdue-sweep') return overdueSweepAllTenants();
    if (job.name === 'expired-files') return expiredFilesSweepAllTenants();
    throw new Error(`Unknown job ${job.name}`);
  },
  { connection, concurrency: 1 },
);

const jobsWorker = new Worker(
  JOB_QUEUE,
  async (job) => processJob(job.name as JobKind, job.data as JobPayload),
  // Imports/exports are heavy and run one transaction batch at a time; two in parallel is plenty.
  { connection, concurrency: 2, lockDuration: 5 * 60_000 },
);

for (const w of [systemWorker, jobsWorker]) {
  w.on('completed', (job) =>
    console.log(JSON.stringify({ level: 'info', msg: 'job done', queue: w.name, job: job.name, id: job.id })),
  );
  w.on('failed', (job, err) =>
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'job failed',
        queue: w.name,
        job: job?.name,
        id: job?.id,
        error: err.message,
      }),
    ),
  );
}
console.log(
  JSON.stringify({ level: 'info', msg: 'aVn CMS worker started', queues: [SYSTEM_QUEUE, JOB_QUEUE] }),
);

async function shutdown() {
  await Promise.all([systemWorker.close(), jobsWorker.close()]);
  await system.close();
  await connection.quit();
  await disconnectAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
