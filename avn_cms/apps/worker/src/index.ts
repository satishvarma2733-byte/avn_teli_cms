import { getConfig } from '@avn-cms/config';
import { disconnectAll } from '@avn-cms/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { overdueSweepAllTenants } from './jobs';

/**
 * aVn CMS worker: runs scheduled system jobs through BullMQ (one Redis, any number of web
 * instances). Repeatable jobs are deduplicated by BullMQ, so several workers can run safely.
 */
const config = getConfig();
if (!config.REDIS_URL) throw new Error('REDIS_URL is required for the worker');

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const QUEUE = 'avn-system';

const queue = new Queue(QUEUE, { connection });
await queue.upsertJobScheduler('overdue-sweep', { every: 5 * 60_000 }, { name: 'overdue-sweep' });

const worker = new Worker(
  QUEUE,
  async (job) => {
    if (job.name === 'overdue-sweep') return overdueSweepAllTenants();
    throw new Error(`Unknown job ${job.name}`);
  },
  { connection, concurrency: 1 },
);

worker.on('completed', (job, result) =>
  console.log(JSON.stringify({ level: 'info', msg: 'job done', job: job.name, result })),
);
worker.on('failed', (job, err) =>
  console.error(JSON.stringify({ level: 'error', msg: 'job failed', job: job?.name, error: err.message })),
);
console.log(JSON.stringify({ level: 'info', msg: 'aVn CMS worker started', queue: QUEUE }));

async function shutdown() {
  await worker.close();
  await queue.close();
  await connection.quit();
  await disconnectAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
