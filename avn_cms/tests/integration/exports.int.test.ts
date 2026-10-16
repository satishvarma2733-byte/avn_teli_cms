import { AppError, exportsService, leads, openDownload, processJob } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};
const parts = (u: string) => {
  const url = new URL(u, 'http://x');
  return [url.pathname.split('/').pop()!, url.searchParams.get('exp'), url.searchParams.get('sig')] as const;
};
async function download(ctx: Parameters<typeof openDownload>[0], u: string) {
  const r = await openDownload(ctx, ...parts(u));
  if (r.expired) throw new Error('expired');
  return r;
}

describe('exports', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let c1: Awaited<ReturnType<typeof makeUser>>;
  let c2: Awaited<ReturnType<typeof makeUser>>;
  let t1: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('exp');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    c1 = await makeUser(tenant.id, 'COUNSELOR');
    c2 = await makeUser(tenant.id, 'COUNSELOR');
    t1 = await makeUser(tenant.id, 'TELECALLER');
    const mine = await makeLead(tenant.id, {
      counselorId: c1.id,
      telecallerId: t1.id,
      name: '=HYPERLINK("http://evil.test","click")',
    });
    await ownerDb().student.update({
      where: { id: mine.student.id },
      data: { email: 'secret@example.test', address: '1 Hidden Street' },
    });
    await makeLead(tenant.id, { counselorId: c1.id, name: 'Second Mine', stage: 'CONTACTED' });
    await makeLead(tenant.id, { counselorId: c2.id, name: 'Not Yours' });
  });

  it('CSV export: same rows as the workspace filter, formula cells neutralised, download audited', async () => {
    const ex = await exportsService.requestExport(ctxFor(admin), {
      entity: 'leads',
      format: 'csv',
      filters: {},
    });
    expect(ex.status).toBe('DONE');
    expect(ex.rows).toBe(3);
    const file = await download(ctxFor(admin), ex.downloadUrl!);
    const text = file.data.toString('utf8');
    expect(text.startsWith('﻿Student name,Mobile number')).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(
      await ownerDb().auditLog.count({ where: { tenantId: tenant.id, action: 'export.downloaded' } }),
    ).toBe(1);

    const filtered = await exportsService.requestExport(ctxFor(admin), {
      entity: 'leads',
      format: 'csv',
      filters: { stage: 'CONTACTED' },
    });
    const listed = await leads.listLeads(ctxFor(admin), {
      view: 'all',
      sort: 'newest',
      limit: 50,
      stage: 'CONTACTED',
    });
    expect(filtered.rows).toBe(listed.total);
  });

  it('counselors export only their own leads; telecallers get the reduced columns', async () => {
    const mine = await exportsService.requestExport(ctxFor(c1), {
      entity: 'leads',
      format: 'csv',
      filters: {},
    });
    expect(mine.rows).toBe(2);
    expect((await download(ctxFor(c1), mine.downloadUrl!)).data.toString('utf8')).not.toContain('Not Yours');

    const tele = await exportsService.requestExport(ctxFor(t1), {
      entity: 'leads',
      format: 'csv',
      filters: {},
    });
    expect(tele.rows).toBe(1);
    const t = (await download(ctxFor(t1), tele.downloadUrl!)).data.toString('utf8');
    const header = t.split('\n')[0]!;
    expect(header).not.toContain('Email');
    expect(header).not.toContain('Address');
    expect(t).not.toContain('secret@example.test');
    expect(t).not.toContain('1 Hidden Street');
  });

  it('XLSX and PDF exports produce real files', async () => {
    const x = await exportsService.requestExport(ctxFor(admin), {
      entity: 'leads',
      format: 'xlsx',
      filters: {},
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await download(ctxFor(admin), x.downloadUrl!)).data as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).getCell(1).value).toBe('Student name');
    expect(ws.rowCount).toBe(4);
    const names = [2, 3, 4].map((r) => String(ws.getRow(r).getCell(1).value));
    expect(names).toContain(`'=HYPERLINK("http://evil.test","click")`);

    const p = await exportsService.requestExport(ctxFor(admin), {
      entity: 'leads',
      format: 'pdf',
      filters: {},
    });
    const pdf = (await download(ctxFor(admin), p.downloadUrl!)).data;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(p.filename).toMatch(/^leads-.*\.pdf$/);
  });

  it('download links are personal, tamper-proof and expire', async () => {
    const ex = await exportsService.requestExport(ctxFor(c1), {
      entity: 'leads',
      format: 'csv',
      filters: {},
    });
    const [id, exp, sig] = parts(ex.downloadUrl!);
    // Another user — even an admin, even with the exact link — gets 404 for someone's export.
    expect(await code(openDownload(ctxFor(admin), id, exp, sig))).toBe('NOT_FOUND');
    expect(await code(openDownload(ctxFor(c2), id, exp, sig))).toBe('NOT_FOUND');
    expect(await code(openDownload(ctxFor(c1), id, exp, `${sig!.slice(0, -2)}xx`))).toBe('NOT_FOUND');
    expect(await code(openDownload(ctxFor(c1), id, String(Number(exp) + 60), sig))).toBe('NOT_FOUND');
    // Others can't even see the export job.
    expect(await code(exportsService.getExport(ctxFor(c2), ex.id))).toBe('NOT_FOUND');
    // An expired (but genuine) link says so.
    const { signedDownloadPathForTest } = await import('./helpers/sign');
    const [, e2, s2] = parts(signedDownloadPathForTest(id, c1.id, -10));
    expect(await openDownload(ctxFor(c1), id, e2, s2)).toEqual({ expired: true });
  });

  it('only admins can export web leads', async () => {
    expect(
      await code(
        exportsService.requestExport(ctxFor(c1), { entity: 'web_leads', format: 'csv', filters: {} }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        exportsService.requestExport(ctxFor(admin), { entity: 'web_leads', format: 'csv', filters: {} }),
      ),
    ).toBe('OK');
  });

  it('a user disabled after asking gets no file (permission re-checked at run time)', async () => {
    const job = await ownerDb().exportJob.create({
      data: {
        tenantId: tenant.id,
        requestedById: c1.id,
        type: 'leads',
        status: 'QUEUED',
        params: {
          entity: 'leads',
          format: 'csv',
          filters: {},
          requestedBy: { userId: c1.id, role: 'COUNSELOR' },
        },
      },
    });
    await ownerDb().user.update({ where: { id: c1.id }, data: { status: 'DISABLED' } });
    await processJob('export.run', { tenantId: tenant.id, jobId: job.id });
    const after = await ownerDb().exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('FAILED');
    expect(after.fileKey).toBeNull();
  });

  it('bad filters fail at request time, not in the background', async () => {
    expect(
      await code(
        exportsService.requestExport(ctxFor(admin), {
          entity: 'leads',
          format: 'csv',
          filters: { stage: 'NOPE' },
        }),
      ),
    ).toBe('VALIDATION_ERROR');
  });
});
