import { getConfig } from '@avn-cms/config';
import { JOB_QUEUE } from '@avn-cms/core';
import { disconnectAll } from '@avn-cms/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { createJobsWorker, createSystemWorker, scheduleSystemJobs, SYSTEM_QUEUE } from './workers';

/**
 * aVn CMS worker entrypoint: boots the BullMQ workers (see workers.ts) and shuts them down
 * cleanly. Needs Redis.
 */
const config = getConfig();
if (!config.REDIS_URL) throw new Error('REDIS_URL is required for the worker');

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const system = new Queue(SYSTEM_QUEUE, { connection });
await scheduleSystemJobs(system);

const systemWorker = createSystemWorker(connection);
const jobsWorker = createJobsWorker(connection);

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
