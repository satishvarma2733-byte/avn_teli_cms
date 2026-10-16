import { createServer } from 'node:net';

import { resetConfigForTests } from '@avn-cms/config';
import { closeQueue, exportsService, imports } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enqueue } from '../../packages/core/src/jobs/queue';
import type * as QueueModule from '../../packages/core/src/jobs/queue';
import { ctxFor } from '../fixtures/ctx';
import { makeTenant, makeUser, resetData } from '../fixtures/factory';

// Every other test runs jobs inline. Here `enqueue` is the real one, except that it gives up on an
// unanswered queue after a second instead of ten, so the unreachable-Redis tests stay quick.
vi.mock('../../packages/core/src/jobs/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>();
  return {
    ...actual,
    enqueue: vi.fn((...args: Parameters<typeof actual.enqueue>) =>
      actual.enqueue(args[0], args[1], { timeoutMs: 1_000, ...args[2] }),
    ),
  };
});

/**
 * A job whose request to the queue failed (docs/IMPORT_EXPORT.md §7): the row is recorded as QUEUED
 * before `enqueue`, and no worker will ever claim it if the queue never got it. The stuck-jobs
 * sweep leaves QUEUED alone (a job may wait for a worker), so the services put the job back
 * themselves: an import returns to VALIDATED, an export fails with a plain message. The request
 * still errors.
 */
describe('a job the queue refused', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let website: { id: string };

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('enq');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@enq.test');
    website = await ownerDb().leadSource.findFirstOrThrow({
      where: { tenantId: tenant.id, code: 'WEBSITE' },
    });
  });

  afterEach(async () => {
    delete process.env['REDIS_URL'];
    resetConfigForTests();
    await closeQueue();
    vi.restoreAllMocks();
  });

  const ctx = () => ctxFor(admin);
  const importRow = (id: string) => ownerDb().importJob.findUniqueOrThrow({ where: { id } });
  const exportRow = (id: string) => ownerDb().exportJob.findUniqueOrThrow({ where: { id } });

  /** An import that has been checked and is waiting for "Start import". */
  async function validatedImport(rows = 3) {
    const lines = ['Student Name,Mobile,City'];
    for (let i = 0; i < rows; i++) lines.push(`Retry ${i},9${String(400_000_000 + i).slice(-9)},Guntur`);
    const draft = await imports.createDraft(ctx(), {
      filename: 'retry.csv',
      mimeType: 'text/csv',
      data: Buffer.from(lines.join('\n')),
    });
    await imports.startValidation(ctx(), draft.id, {
      mapping: draft.suggested as Record<string, number>,
      defaultSourceId: website.id,
      duplicateMode: 'skip',
      roundRobin: false,
    });
    expect((await importRow(draft.id)).status).toBe('VALIDATED');
    return draft;
  }

  /** Redis is configured but nothing listens there (a port that was just closed). */
  async function pointAtUnreachableRedis() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    process.env['REDIS_URL'] = `redis://127.0.0.1:${port}`;
    resetConfigForTests();
    // BullMQ reports every refused connection on the console while it waits.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  }

  it('puts an import back to VALIDATED, and it can be started again', async () => {
    const draft = await validatedImport();

    vi.mocked(enqueue).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    await expect(imports.startRun(ctx(), draft.id, 'update')).rejects.toThrow('ECONNREFUSED');

    // Not stuck: the screen offers "Start import" and "Cancel import" again.
    const back = await imports.getImport(ctx(), draft.id);
    expect(back.status).toBe('VALIDATED');
    expect(back.finishedAt).toBeNull();
    expect(back.result).toMatchObject({ total: 3, valid: 3 }); // the check results are still there
    expect(await ownerDb().student.count({ where: { tenantId: tenant.id } })).toBe(0);

    await imports.startRun(ctx(), draft.id, 'skip');
    const done = await imports.getImport(ctx(), draft.id);
    expect(done.status).toBe('DONE');
    expect(done.result).toMatchObject({ created: 3, failed: 0 });
    expect(await ownerDb().student.count({ where: { tenantId: tenant.id } })).toBe(3);
  });

  it('lets the person cancel an import the queue refused', async () => {
    const draft = await validatedImport();
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('queue is down'));
    await expect(imports.startRun(ctx(), draft.id, 'skip')).rejects.toThrow('queue is down');

    await imports.cancelImport(ctx(), draft.id);
    expect((await importRow(draft.id)).status).toBe('CANCELED');
  });

  it('fails an export with a plain message, and it can be requested again', async () => {
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    await expect(
      exportsService.requestExport(ctx(), { entity: 'leads', format: 'csv', filters: {} }),
    ).rejects.toThrow('ECONNREFUSED');

    const [failed] = await exportsService.listExports(ctx());
    expect(failed).toMatchObject({
      status: 'FAILED',
      error: 'The export could not be started. Try again.',
      downloadUrl: null,
    });
    expect(failed!.finishedAt).not.toBeNull();
    expect((await exportRow(failed!.id)).status).toBe('FAILED');

    const again = await exportsService.requestExport(ctx(), { entity: 'leads', format: 'csv', filters: {} });
    expect(again.status).toBe('DONE');
    expect(again.id).not.toBe(failed!.id);
  });

  it('leaves a job alone if a worker already claimed it', async () => {
    // The add reached Redis and a worker took the job, but the answer was lost on the way back.
    const draft = await validatedImport();
    vi.mocked(enqueue).mockImplementationOnce(async () => {
      await ownerDb().importJob.update({
        where: { id: draft.id },
        data: { status: 'RUNNING', heartbeatAt: new Date() },
      });
      throw new Error('connection reset');
    });
    await expect(imports.startRun(ctx(), draft.id, 'skip')).rejects.toThrow('connection reset');
    expect((await importRow(draft.id)).status).toBe('RUNNING');

    vi.mocked(enqueue).mockImplementationOnce(async () => {
      const [exp] = await ownerDb().exportJob.findMany({ where: { tenantId: tenant.id } });
      await ownerDb().exportJob.update({
        where: { id: exp!.id },
        data: { status: 'RUNNING', heartbeatAt: new Date() },
      });
      throw new Error('connection reset');
    });
    await expect(
      exportsService.requestExport(ctx(), { entity: 'leads', format: 'csv', filters: {} }),
    ).rejects.toThrow('connection reset');
    const [exp] = await ownerDb().exportJob.findMany({ where: { tenantId: tenant.id } });
    expect(exp!.status).toBe('RUNNING');
  });

  it('does not hang when Redis is unreachable: the import goes back to VALIDATED', async () => {
    const draft = await validatedImport();
    await pointAtUnreachableRedis();

    const started = Date.now();
    await expect(imports.startRun(ctx(), draft.id, 'skip')).rejects.toThrow('did not answer in time');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await importRow(draft.id)).status).toBe('VALIDATED');

    // Redis is back (inline again, as in every other test): the same import runs.
    delete process.env['REDIS_URL'];
    resetConfigForTests();
    await closeQueue();
    await imports.startRun(ctx(), draft.id, 'skip');
    expect((await importRow(draft.id)).status).toBe('DONE');
    expect(await ownerDb().student.count({ where: { tenantId: tenant.id } })).toBe(3);
  });

  it('does not hang when Redis is unreachable: the export fails and says so', async () => {
    await pointAtUnreachableRedis();

    await expect(
      exportsService.requestExport(ctx(), { entity: 'leads', format: 'csv', filters: {} }),
    ).rejects.toThrow('did not answer in time');
    const [failed] = await exportsService.listExports(ctx());
    expect(failed).toMatchObject({
      status: 'FAILED',
      error: 'The export could not be started. Try again.',
    });
  });
});
