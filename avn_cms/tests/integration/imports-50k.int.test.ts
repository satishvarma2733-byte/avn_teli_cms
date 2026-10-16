import { imports, openDownload } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeAll, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeTenant, makeUser, resetData } from '../fixtures/factory';

/**
 * Phase 6 exit criterion: a 50k-row CSV imports as a job with a per-row error report.
 * 50,000 good rows (TEST DATA) plus 100 broken ones; the run must create exactly the good
 * rows and the report must list exactly the broken ones.
 */
const ROWS = 50_000;
const BAD = 100;

describe('50k-row import', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;

  beforeAll(async () => {
    await resetData();
    tenant = await makeTenant('bulk');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    await makeUser(tenant.id, 'COUNSELOR', 'c1@bulk.test');
  });

  it('imports 50,000 rows in the background and reports the 100 bad ones', async () => {
    const lines = ['Student Name,Mobile,City,Status,Counsellor,Remarks'];
    for (let i = 0; i < ROWS; i++) {
      const phone = `9${String(100_000_000 + i).slice(-9)}`; // 9100000000…: valid Indian mobiles
      lines.push(
        `Bulk Student ${i},${phone},Guntur,${i % 3 === 0 ? 'Interested' : 'New'},${i % 2 ? 'c1@bulk.test' : ''},row ${i}`,
      );
    }
    for (let i = 0; i < BAD; i++) lines.push(`Broken ${i},12${i},,,,`);
    const data = Buffer.from(lines.join('\n'));
    const ctx = ctxFor(admin);
    const website = await ownerDb().leadSource.findFirstOrThrow({
      where: { tenantId: tenant.id, code: 'WEBSITE' },
    });

    const t0 = Date.now();
    const draft = await imports.createDraft(ctx, { filename: 'bulk.csv', mimeType: 'text/csv', data });
    expect(draft.rowCount).toBe(ROWS + BAD);
    await imports.startValidation(ctx, draft.id, {
      mapping: draft.suggested as Record<string, number>,
      defaultSourceId: website.id,
      duplicateMode: 'skip',
      roundRobin: false,
    });
    const validated = await imports.getImport(ctx, draft.id);
    expect(validated.result).toMatchObject({ total: ROWS + BAD, valid: ROWS, invalid: BAD, newRows: ROWS });
    const tValidate = Date.now() - t0;

    await imports.startRun(ctx, draft.id, 'skip');
    const done = await imports.getImport(ctx, draft.id);
    const tTotal = Date.now() - t0;
    expect(done.status).toBe('DONE');
    expect(done.result).toMatchObject({ created: ROWS, failed: BAD, skipped: 0 });

    const db = ownerDb();
    expect(await db.student.count({ where: { tenantId: tenant.id } })).toBe(ROWS);
    expect(await db.lead.count({ where: { tenantId: tenant.id, stage: 'INTERESTED' } })).toBe(
      Math.ceil(ROWS / 3),
    );
    expect(await db.leadAssignment.count({ where: { tenantId: tenant.id, isActive: true } })).toBe(ROWS / 2);
    expect(await db.leadStatusHistory.count({ where: { tenantId: tenant.id } })).toBe(
      ROWS + Math.ceil(ROWS / 3),
    );

    const url = new URL(done.errorReportUrl!, 'http://x');
    const report = await openDownload(
      ctx,
      url.pathname.split('/').pop()!,
      url.searchParams.get('exp'),
      url.searchParams.get('sig'),
    );
    if (report.expired) throw new Error('report link expired');
    const reportLines = report.data.toString('utf8').trim().split('\n');
    expect(reportLines).toHaveLength(BAD + 1); // header + one line per broken row
    expect(reportLines[1]).toContain(`${ROWS + 2},error,phone`);

    console.log(
      JSON.stringify({
        msg: '50k import timing',
        validateMs: tValidate,
        totalMs: tTotal,
        rowsPerSecond: Math.round(ROWS / (tTotal / 1000)),
      }),
    );
    expect(tTotal).toBeLessThan(240_000);
  }, 300_000);
});
