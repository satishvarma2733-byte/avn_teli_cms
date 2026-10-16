import { resetConfigForTests } from '@avn-cms/config';
import { closeQueue, exportsService, imports, JOB_QUEUE, openDownload } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createJobsWorker } from '../../apps/worker/src/workers';
import { ctxFor } from '../fixtures/ctx';
import { makeTenant, makeUser, resetData } from '../fixtures/factory';

/**
 * The background-job path against a real Redis: the web side enqueues on the `avn-jobs` BullMQ
 * queue and the worker's own consumer (apps/worker/src/workers.ts) runs `processJob`. The other
 * suites run jobs inline (NODE_ENV=test without REDIS_URL), so this is the only place the queue
 * itself is exercised.
 *
 * Needs the docker Redis (`pnpm stack:up`, host port 16390). It uses Redis database 15, so a
 * worker or dev server running against database 0 never sees these jobs, and the test may
 * empty its own database freely.
 */
const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:16390/15';

const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(',')).join('\n'));

async function waitFor<T>(what: string, read: () => Promise<T | undefined | false>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('background jobs through BullMQ and Redis', () => {
  let connection: Redis;
  let queue: Queue;
  let worker: ReturnType<typeof createJobsWorker>;
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let website: { id: string };

  beforeAll(async () => {
    // Never flush the default database: it may hold real development queues.
    if (!/\/[1-9]\d*$/.test(REDIS_URL))
      throw new Error(`TEST_REDIS_URL must name a Redis database other than 0 (got ${REDIS_URL}).`);
    connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    connection.on('error', () => undefined);
    try {
      await connection.connect();
      await connection.ping();
    } catch (cause) {
      throw new Error(`Redis is not reachable at ${REDIS_URL}. Start it with "pnpm stack:up".`, { cause });
    }
    await connection.flushdb();
    // The web side finds the queue through REDIS_URL, like production.
    process.env['REDIS_URL'] = REDIS_URL;
    resetConfigForTests();
    queue = new Queue(JOB_QUEUE, { connection });
    worker = createJobsWorker(connection);
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await closeQueue();
    delete process.env['REDIS_URL'];
    resetConfigForTests();
    if (connection) {
      await connection.flushdb().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    }
  });

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('bq');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@bq.test');
    website = await ownerDb().leadSource.findFirstOrThrow({
      where: { tenantId: tenant.id, code: 'WEBSITE' },
    });
  });

  const ctx = () => ctxFor(admin);
  const statusOf = async (id: string) => (await imports.getImport(ctx(), id)).status;
  const options = (mapping: object) => ({
    mapping: mapping as Record<string, number>,
    defaultSourceId: website.id,
    duplicateMode: 'skip' as const,
    roundRobin: false,
  });

  it('runs an import (check, then run) and an export on the worker', async () => {
    const draft = await imports.createDraft(ctx(), {
      filename: 'via-queue.csv',
      mimeType: 'text/csv',
      data: csv([
        ['Student name', 'Mobile number', 'City'],
        ['Queue One', '9000011111', 'Guntur'],
        ['Queue Two', '9000022222', 'Nellore'],
        ['Broken Row', '123', ''],
      ]),
    });

    // The check is queued, not run in this process: the request returns before the worker is done.
    await imports.startValidation(ctx(), draft.id, options(draft.suggested));
    await waitFor('the check to finish', async () => (await statusOf(draft.id)) === 'VALIDATED');
    const checked = await imports.getImport(ctx(), draft.id);
    expect(checked.result).toMatchObject({ total: 3, valid: 2, invalid: 1 });
    expect(checked.options?.mapping).toMatchObject(draft.suggested);

    await imports.startRun(ctx(), draft.id, 'skip');
    await waitFor('the import to finish', async () => (await statusOf(draft.id)) === 'DONE');
    const done = await imports.getImport(ctx(), draft.id);
    expect(done.result).toMatchObject({ created: 2, skipped: 0, failed: 1 });
    const students = await ownerDb().student.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: 'asc' },
    });
    expect(students.map((s) => s.name)).toEqual(['Queue One', 'Queue Two']);

    // An export of what the import just created.
    const requested = await exportsService.requestExport(ctx(), {
      entity: 'leads',
      format: 'csv',
      filters: {},
    });
    const ready = await waitFor('the export to finish', async () => {
      const view = await exportsService.getExport(ctx(), requested.id);
      return view.status === 'DONE' && view;
    });
    expect(ready.rows).toBe(2);
    const url = new URL(ready.downloadUrl!, 'http://x');
    const file = await openDownload(
      ctx(),
      url.pathname.split('/').pop()!,
      url.searchParams.get('exp'),
      url.searchParams.get('sig'),
    );
    if (file.expired) throw new Error('the download link expired');
    const text = file.data.toString('utf8');
    expect(text).toContain('Queue One');
    expect(text).toContain('Queue Two');

    // BullMQ ran exactly these three jobs for them, all to completion.
    const completed = (await queue.getJobs(['completed'])).filter((j) =>
      [draft.id, requested.id].includes((j.data as { jobId: string }).jobId),
    );
    expect(completed.map((j) => j.name).sort()).toEqual(['export.run', 'import.run', 'import.validate']);
    expect(completed.find((j) => j.name === 'import.run')?.data).toEqual({
      tenantId: tenant.id,
      jobId: draft.id,
    });
    expect(await queue.getJobCounts('failed', 'active', 'waiting', 'delayed')).toEqual({
      failed: 0,
      active: 0,
      waiting: 0,
      delayed: 0,
    });
  });

  it('runs the check again when an import is started over', async () => {
    const draft = await imports.createDraft(ctx(), {
      filename: 'again.csv',
      mimeType: 'text/csv',
      data: csv([
        ['Student name', 'Mobile number', 'City'],
        ['Again One', '9000033333', 'Guntur'],
      ]),
    });
    await imports.startValidation(ctx(), draft.id, options(draft.suggested));
    await waitFor('the first check', async () => (await statusOf(draft.id)) === 'VALIDATED');

    // "Change columns" / "Check the file again": the same import is queued a second time.
    await imports.startValidation(ctx(), draft.id, options(draft.suggested));
    expect(await statusOf(draft.id)).toBe('VALIDATING');
    await waitFor('the second check', async () => (await statusOf(draft.id)) === 'VALIDATED');
    const checks = (await queue.getJobs(['completed'])).filter(
      (j) => j.name === 'import.validate' && (j.data as { jobId: string }).jobId === draft.id,
    );
    expect(checks).toHaveLength(2);
  });
});
