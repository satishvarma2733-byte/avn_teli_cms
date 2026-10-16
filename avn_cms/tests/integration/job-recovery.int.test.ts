import { exportsService, failStuckJobs, imports, processJob, STALE_AFTER_MS } from '@avn-cms/core';
import { withTenant, type JobStatus } from '@avn-cms/db';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeEach, describe, expect, it } from 'vitest';

import { stuckJobsSweepAllTenants } from '../../apps/worker/src/jobs';
import { ctxFor } from '../fixtures/ctx';
import { makeTenant, makeUser, resetData } from '../fixtures/factory';

/**
 * Recovery of cut-off imports and exports (docs/IMPORT_EXPORT.md §7): a worker that dies leaves
 * its job RUNNING; the worker's sweep marks it FAILED, and the person can start over without
 * duplicating anything. Jobs run inline here (no Redis); the BullMQ path is bullmq-jobs.int.test.ts.
 */
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const sweep = (tenantId: string, now = new Date()) => withTenant(tenantId, (db) => failStuckJobs(db, now));

describe('recovery of cut-off jobs', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let website: { id: string };

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('rec');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@rec.test');
    website = await ownerDb().leadSource.findFirstOrThrow({
      where: { tenantId: tenant.id, code: 'WEBSITE' },
    });
  });

  const ctx = () => ctxFor(admin);
  const requestedBy = () => ({ userId: admin.id, role: admin.roleCode });

  async function makeImportJob(
    status: JobStatus,
    opts: { heartbeatAt?: Date | null; createdAt?: Date; result?: object } = {},
  ) {
    return ownerDb().importJob.create({
      data: {
        tenantId: tenant.id,
        requestedById: admin.id,
        type: 'students',
        status,
        params: { filename: 'cut-off.csv', requestedBy: requestedBy() },
        result: opts.result ?? {},
        heartbeatAt: opts.heartbeatAt === undefined ? new Date() : opts.heartbeatAt,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
  }
  async function makeExportJob(
    status: JobStatus,
    opts: { heartbeatAt?: Date | null; createdAt?: Date } = {},
  ) {
    return ownerDb().exportJob.create({
      data: {
        tenantId: tenant.id,
        requestedById: admin.id,
        type: 'leads',
        status,
        params: { entity: 'leads', format: 'csv', filters: {}, requestedBy: requestedBy() },
        heartbeatAt: opts.heartbeatAt === undefined ? new Date() : opts.heartbeatAt,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
  }
  const importRow = (id: string) => ownerDb().importJob.findUniqueOrThrow({ where: { id } });
  const exportRow = (id: string) => ownerDb().exportJob.findUniqueOrThrow({ where: { id } });

  it('fails only claimed jobs that have been silent for 10 minutes', async () => {
    expect(STALE_AFTER_MS).toBe(10 * 60_000);
    const silentRun = await makeImportJob('RUNNING', {
      heartbeatAt: minutesAgo(11),
      result: { processed: 1500, total: 5000, created: 1400, skipped: 100 },
    });
    const busyRun = await makeImportJob('RUNNING', { heartbeatAt: minutesAgo(9) });
    const legacyRun = await makeImportJob('RUNNING', { heartbeatAt: null, createdAt: minutesAgo(30) });
    const silentCheck = await makeImportJob('VALIDATING', { heartbeatAt: minutesAgo(11) });
    // Waiting for a worker is not a failure, and finished jobs are history.
    const waiting = await makeImportJob('QUEUED', { heartbeatAt: minutesAgo(60) });
    const finished = await makeImportJob('DONE', { heartbeatAt: minutesAgo(60) });
    const silentExport = await makeExportJob('RUNNING', { heartbeatAt: minutesAgo(11) });
    const busyExport = await makeExportJob('RUNNING', { heartbeatAt: minutesAgo(1) });
    const waitingExport = await makeExportJob('QUEUED', { heartbeatAt: minutesAgo(60) });

    expect(await sweep(tenant.id)).toEqual({ imports: 3, exports: 1 });

    // The run keeps its progress and says, plainly, what happened and what to do.
    const run = await importRow(silentRun.id);
    expect(run.status).toBe('FAILED');
    expect(run.finishedAt).not.toBeNull();
    expect(run.result).toMatchObject({
      failedIn: 'run',
      processed: 1500,
      total: 5000,
      created: 1400,
      error: expect.stringContaining('The import stopped before it finished'),
    });
    expect((run.result as { error: string }).error).toContain('1,500 of 5,000 rows had been processed');
    expect((await importRow(legacyRun.id)).status).toBe('FAILED');

    const check = await importRow(silentCheck.id);
    expect(check.status).toBe('FAILED');
    expect(check.result).toMatchObject({
      failedIn: 'check',
      error: expect.stringContaining('The check stopped before it finished'),
    });

    for (const untouched of [busyRun, waiting, finished])
      expect((await importRow(untouched.id)).status).toBe(untouched.status);

    const failedExport = await exportRow(silentExport.id);
    expect(failedExport.status).toBe('FAILED');
    expect((await exportsService.getExport(ctx(), silentExport.id)).error).toContain(
      'The export stopped before it finished',
    );
    for (const untouched of [busyExport, waitingExport])
      expect((await exportRow(untouched.id)).status).toBe(untouched.status);

    // Nothing left to do on a second pass.
    expect(await sweep(tenant.id)).toEqual({ imports: 0, exports: 0 });
  });

  it('a job that is re-delivered after it was failed does not run again', async () => {
    const run = await makeImportJob('RUNNING', { heartbeatAt: minutesAgo(11) });
    const exp = await makeExportJob('RUNNING', { heartbeatAt: minutesAgo(11) });
    await sweep(tenant.id);

    // What BullMQ does with a stalled job: hand it to a worker again.
    await processJob('import.run', { tenantId: tenant.id, jobId: run.id });
    await processJob('export.run', { tenantId: tenant.id, jobId: exp.id });
    expect((await importRow(run.id)).status).toBe('FAILED');
    expect((await exportRow(exp.id)).status).toBe('FAILED');
    expect(await ownerDb().student.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('the worker sweep covers every workspace', async () => {
    const other = await makeTenant('rec-other', 'SUSPENDED');
    const otherAdmin = await makeUser(other.id, 'TENANT_ADMIN');
    const mine = await makeImportJob('RUNNING', { heartbeatAt: minutesAgo(20) });
    const theirs = await ownerDb().exportJob.create({
      data: {
        tenantId: other.id,
        requestedById: otherAdmin.id,
        type: 'leads',
        status: 'RUNNING',
        params: { entity: 'leads', format: 'csv', filters: {} },
        heartbeatAt: minutesAgo(20),
      },
    });

    const results = await stuckJobsSweepAllTenants();
    expect(results.map((r) => [r.tenant, r.imports, r.exports]).sort()).toEqual([
      ['rec', 1, 0],
      ['rec-other', 0, 1],
    ]);
    expect((await importRow(mine.id)).status).toBe('FAILED');
    expect((await exportRow(theirs.id)).status).toBe('FAILED');
  });

  /**
   * The real runner, cut off in the middle: recovery fails the job while batches are still being
   * written (as if the worker had been judged dead but was only slow). The runner must stop
   * without overwriting that, and starting over must finish the file without duplicating anyone.
   */
  it('stops a run that was failed under it, and starting over finishes the file once', async () => {
    const ROWS = 2_400; // five batches of 500
    const lines = ['Student Name,Mobile,City'];
    for (let i = 0; i < ROWS; i++) lines.push(`Cut Off ${i},9${String(200_000_000 + i).slice(-9)},Guntur`);
    const draft = await imports.createDraft(ctx(), {
      filename: 'cut-off.csv',
      mimeType: 'text/csv',
      data: Buffer.from(lines.join('\n')),
    });
    const options = (duplicateMode: 'skip' | 'update') => ({
      mapping: draft.suggested as Record<string, number>,
      defaultSourceId: website.id,
      duplicateMode,
      roundRobin: false,
    });
    await imports.startValidation(ctx(), draft.id, options('skip'));
    expect((await imports.getImport(ctx(), draft.id)).status).toBe('VALIDATED');

    const running = imports.startRun(ctx(), draft.id, 'skip'); // inline: resolves when the runner returns
    try {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const job = await importRow(draft.id);
        if (job.status === 'RUNNING' && (job.result as { processed?: number }).processed) break;
        // Not started yet (VALIDATED → QUEUED → RUNNING), or running but between batches.
        if (!['VALIDATED', 'QUEUED', 'RUNNING'].includes(job.status))
          throw new Error(`ended early: ${job.status}`);
        if (Date.now() > deadline) throw new Error('the run never reported progress');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // "Ten minutes later" for the sweep, while the runner is between batches.
      expect(await sweep(tenant.id, new Date(Date.now() + STALE_AFTER_MS + 60_000))).toEqual({
        imports: 1,
        exports: 0,
      });
    } finally {
      // Never leave the runner going into the next test.
      await running.catch(() => undefined);
    }
    await running;

    const failed = await importRow(draft.id);
    expect(failed.status).toBe('FAILED');
    const failedResult = failed.result as {
      processed: number;
      total: number;
      error: string;
      failedIn: string;
    };
    expect(failedResult).toMatchObject({ failedIn: 'run', total: ROWS });
    expect(failedResult.error).toContain('The import stopped before it finished');
    expect(failedResult.processed).toBeGreaterThanOrEqual(500);
    expect(failedResult.processed).toBeLessThan(ROWS);
    expect(failed.heartbeatAt).not.toBeNull();
    // The runner left no completion behind: no audit row for the run, no half-written "finished".
    expect(await ownerDb().auditLog.count({ where: { tenantId: tenant.id, action: 'import.run' } })).toBe(0);
    const saved = await ownerDb().student.count({ where: { tenantId: tenant.id } });
    expect(saved).toBeGreaterThanOrEqual(500);
    expect(saved).toBeLessThan(ROWS);

    // The screen's "Check the file again": same columns, then run it.
    await imports.startValidation(ctx(), draft.id, options('skip'));
    const again = await imports.getImport(ctx(), draft.id);
    expect(again.status).toBe('VALIDATED');
    expect(again.result).toMatchObject({ total: ROWS, valid: ROWS, existing: saved, newRows: ROWS - saved });
    expect((await importRow(draft.id)).finishedAt).toBeNull();
    await imports.startRun(ctx(), draft.id, 'skip');
    const done = await imports.getImport(ctx(), draft.id);
    expect(done.status).toBe('DONE');
    expect(done.result).toMatchObject({ created: ROWS - saved, skipped: saved, failed: 0 });

    const phones = await ownerDb().student.groupBy({
      by: ['phoneE164'],
      where: { tenantId: tenant.id },
      _count: { _all: true },
    });
    expect(phones).toHaveLength(ROWS);
    expect(phones.every((p) => p._count._all === 1)).toBe(true);
    expect(await ownerDb().lead.count({ where: { tenantId: tenant.id } })).toBe(ROWS);
  });

  it('starting over in "update" mode does not duplicate students either', async () => {
    const ROWS = 30;
    const lines = ['Student Name,Mobile,City'];
    for (let i = 0; i < ROWS; i++) lines.push(`Redo ${i},9${String(300_000_000 + i).slice(-9)},Guntur`);
    const draft = await imports.createDraft(ctx(), {
      filename: 'redo.csv',
      mimeType: 'text/csv',
      data: Buffer.from(lines.join('\n')),
    });
    const options = {
      mapping: draft.suggested as Record<string, number>,
      defaultSourceId: website.id,
      duplicateMode: 'update' as const,
      roundRobin: false,
    };
    await imports.startValidation(ctx(), draft.id, options);
    await imports.startRun(ctx(), draft.id, 'update');
    // Pretend the worker died after the last batch but before DONE was written.
    await ownerDb().importJob.update({
      where: { id: draft.id },
      data: { status: 'RUNNING', heartbeatAt: minutesAgo(15), finishedAt: null },
    });
    expect(await sweep(tenant.id)).toEqual({ imports: 1, exports: 0 });

    await imports.startValidation(ctx(), draft.id, options);
    expect((await imports.getImport(ctx(), draft.id)).result).toMatchObject({ existing: ROWS, newRows: 0 });
    await imports.startRun(ctx(), draft.id, 'update');
    expect((await imports.getImport(ctx(), draft.id)).result).toMatchObject({ created: 0, updated: ROWS });
    expect(await ownerDb().student.count({ where: { tenantId: tenant.id } })).toBe(ROWS);
    expect(await ownerDb().lead.count({ where: { tenantId: tenant.id } })).toBe(ROWS);
  });

  it('a runner that finishes normally leaves a heartbeat and DONE', async () => {
    const draft = await imports.createDraft(ctx(), {
      filename: 'ok.csv',
      mimeType: 'text/csv',
      data: Buffer.from('Student Name,Mobile\nHealthy One,9000044444'),
    });
    await imports.startValidation(ctx(), draft.id, {
      mapping: draft.suggested as Record<string, number>,
      defaultSourceId: website.id,
      duplicateMode: 'skip',
      roundRobin: false,
    });
    expect((await importRow(draft.id)).heartbeatAt).not.toBeNull();
    await imports.startRun(ctx(), draft.id, 'skip');
    const job = await importRow(draft.id);
    expect(job.status).toBe('DONE');
    expect(job.heartbeatAt).not.toBeNull();
    // Healthy jobs are never touched by the sweep, however late it runs after they finished.
    expect(await sweep(tenant.id, new Date(Date.now() + 24 * 3_600_000))).toEqual({
      imports: 0,
      exports: 0,
    });
  });
});
