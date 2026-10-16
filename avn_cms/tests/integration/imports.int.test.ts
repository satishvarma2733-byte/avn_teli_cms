import { AppError, imports, openDownload } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

/** Phase 6 import wizard against a real database (jobs run inline in tests). */
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};
const csv = (rows: string[][]) =>
  Buffer.from(
    rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'),
  );
const urlParts = (u: string) => {
  const url = new URL(u, 'http://x');
  return {
    id: url.pathname.split('/').pop()!,
    exp: url.searchParams.get('exp'),
    sig: url.searchParams.get('sig'),
  };
};

describe('imports', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let counselor: Awaited<ReturnType<typeof makeUser>>;
  let telecaller: Awaited<ReturnType<typeof makeUser>>;
  let website: { id: string };

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('imp');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@imp.test');
    counselor = await makeUser(tenant.id, 'COUNSELOR', 'chai@imp.test');
    telecaller = await makeUser(tenant.id, 'TELECALLER', 'teja@imp.test');
    website = await ownerDb().leadSource.findFirstOrThrow({
      where: { tenantId: tenant.id, code: 'WEBSITE' },
    });
  });

  /** Upload → validate with the suggested mapping → return the validated view. */
  async function draftAndValidate(
    data: Buffer,
    filename = 'leadxp-export.csv',
    extra: Partial<{ roundRobin: boolean }> = {},
  ) {
    const ctx = ctxFor(admin);
    const draft = await imports.createDraft(ctx, { filename, mimeType: 'text/csv', data });
    await imports.startValidation(ctx, draft.id, {
      mapping: draft.suggested as Record<string, number>,
      defaultSourceId: website.id,
      duplicateMode: 'skip',
      roundRobin: extra.roundRobin ?? false,
    });
    return imports.getImport(ctx, draft.id);
  }

  const HEADER = [
    'Student Name',
    'Mobile No',
    'Father Name',
    'Email ID',
    'City',
    'Status',
    'Lead Source',
    'Counsellor',
    'Telecaller',
    'Next Followup',
    'Remarks',
    'NEET',
  ];

  it('LeadXP-style file: dry run reports problems, then the import creates the leads with history', async () => {
    const existing = await makeLead(tenant.id, { name: 'Already Here' });
    const file = csv([
      HEADER,
      [
        'Riya Rao',
        '98765 43210',
        'Ravi Rao',
        'riya@example.test',
        'Guntur',
        'Interested',
        'Google Ads',
        'chai@imp.test',
        'teja@imp.test',
        '20-12-2030 11:00',
        'Wants Georgia',
        '512',
      ],
      ['No Phone', '', '', '', '', '', '', '', '', '', '', ''],
      ['Bad Phone', '12345', '', '', '', '', '', '', '', '', '', ''],
      ['Riya Again', '+91 98765 43210', '', '', '', '', '', '', '', '', '', ''],
      ['Old Student', existing.student.phoneE164, '', '', '', 'Not Enrolled', '', '', '', '', '', ''],
      [
        'Odd Status',
        '9123456780',
        '',
        'not-an-email',
        '',
        'Hot prospect',
        'Hoarding',
        'ghost@imp.test',
        '',
        '',
        '',
        '',
      ],
    ]);
    const v = await draftAndValidate(file);
    expect(v.status).toBe('VALIDATED');
    expect(v.result).toMatchObject({
      total: 6,
      valid: 3,
      invalid: 2,
      duplicatesInFile: 1,
      existing: 1,
      newRows: 2,
    });
    expect(v.result.issuesSample!.map((i) => `${i.line}:${i.field}`)).toEqual(
      expect.arrayContaining([
        '3:phone',
        '4:phone',
        '5:phone',
        '7:email',
        '7:stage',
        '7:source',
        '7:counselor',
      ]),
    );
    // Error report: signed link for this admin only.
    const parts = urlParts(v.errorReportUrl!);
    const report = await openDownload(ctxFor(admin), parts.id, parts.exp, parts.sig);
    expect(report.expired).toBe(false);
    if (!report.expired) expect(report.data.toString('utf8')).toContain('is not a valid mobile number');
    expect(await code(openDownload(ctxFor(counselor), parts.id, parts.exp, parts.sig))).toBe('NOT_FOUND');

    await imports.startRun(ctxFor(admin), v.id, 'skip');
    const done = await imports.getImport(ctxFor(admin), v.id);
    expect(done.status).toBe('DONE');
    expect(done.result).toMatchObject({ created: 2, skipped: 2, failed: 2, updated: 0 });

    const db = ownerDb();
    const riya = await db.student.findFirstOrThrow({
      where: { tenantId: tenant.id, phoneE164: '+919876543210' },
      include: {
        leads: {
          include: { assignments: true, followUps: true, notes: true, statusHistory: true, source: true },
        },
      },
    });
    const lead = riya.leads[0]!;
    expect(riya).toMatchObject({ parentName: 'Ravi Rao', email: 'riya@example.test', town: 'Guntur' });
    expect(lead).toMatchObject({ stage: 'INTERESTED' });
    expect(lead.source.code).toBe('GOOGLE_ADS');
    expect(lead.assignments.map((a) => [a.roleFunction, a.assigneeId]).sort()).toEqual([
      ['COUNSELOR', counselor.id],
      ['TELECALLER', telecaller.id],
    ]);
    expect(lead.followUps).toHaveLength(1);
    expect(lead.followUps[0]!.assigneeId).toBe(telecaller.id);
    expect(lead.nextCallAt).toEqual(lead.followUps[0]!.scheduledAt);
    expect(lead.notes[0]!.body).toBe('Wants Georgia\nNEET score: 512');
    expect(lead.statusHistory.map((h) => h.toStage).sort()).toEqual(['INTERESTED', 'NEW']);
    expect(
      await db.activity.count({
        where: {
          leadId: lead.id,
          type: 'SYSTEM',
          summary: { startsWith: 'Imported from leadxp-export.csv' },
        },
      }),
    ).toBe(1);

    const odd = await db.student.findFirstOrThrow({
      where: { tenantId: tenant.id, phoneE164: '+919123456780' },
      include: { leads: { include: { notes: true } } },
    });
    expect(odd.leads[0]!.stage).toBe('NEW');
    expect(odd.leads[0]!.notes[0]!.body).toContain('Status in the old system: Hot prospect');
    // Skip mode left the existing student alone.
    expect((await db.lead.findUniqueOrThrow({ where: { id: existing.lead.id } })).stage).toBe('NEW');
    expect(await db.auditLog.count({ where: { tenantId: tenant.id, action: 'import.run' } })).toBe(1);

    // A finished import can't be run again.
    expect(await code(imports.startRun(ctxFor(admin), v.id, 'skip'))).toBe('CONFLICT');
  });

  it('update overwrites with imported values and moves the stage; merge only fills gaps', async () => {
    const a = await makeLead(tenant.id, { name: 'Original A' });
    const b = await makeLead(tenant.id, { name: 'Original B' });
    await ownerDb().student.update({ where: { id: b.student.id }, data: { town: 'Vijayawada' } });
    const file = csv([
      ['Name', 'Mobile', 'City', 'Status', 'Counselor'],
      ['Updated A', a.student.phoneE164, 'Guntur', 'Interested', 'chai@imp.test'],
      ['Updated B', b.student.phoneE164, 'Nellore', 'Interested', 'chai@imp.test'],
    ]);
    const v1 = await draftAndValidate(file);
    await imports.startRun(ctxFor(admin), v1.id, 'update');
    expect((await imports.getImport(ctxFor(admin), v1.id)).result).toMatchObject({ updated: 2, created: 0 });
    const sa = await ownerDb().student.findUniqueOrThrow({ where: { id: a.student.id } });
    expect(sa).toMatchObject({ name: 'Updated A', town: 'Guntur' });
    expect((await ownerDb().lead.findUniqueOrThrow({ where: { id: a.lead.id } })).stage).toBe('INTERESTED');
    expect(
      await ownerDb().leadAssignment.count({
        where: { leadId: a.lead.id, isActive: true, assigneeId: counselor.id },
      }),
    ).toBe(1);

    // merge: B keeps its name and town; empty fields would be filled; stage unchanged.
    const c = await makeLead(tenant.id, { name: 'Original C' });
    const file2 = csv([
      ['Name', 'Mobile', 'City', 'Status', 'Email'],
      ['Merged C', c.student.phoneE164, 'Karimnagar', 'Enrolled', 'c@example.test'],
    ]);
    const v2 = await draftAndValidate(file2);
    await imports.startRun(ctxFor(admin), v2.id, 'merge');
    expect((await imports.getImport(ctxFor(admin), v2.id)).result).toMatchObject({ merged: 1 });
    const sc = await ownerDb().student.findUniqueOrThrow({ where: { id: c.student.id } });
    expect(sc).toMatchObject({ name: 'Original C', town: 'Karimnagar', email: 'c@example.test' });
    expect((await ownerDb().lead.findUniqueOrThrow({ where: { id: c.lead.id } })).stage).toBe('NEW');
  });

  it('reads .xlsx files, including real date cells', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leads');
    ws.addRow(['Student name', 'Mobile number', 'Enquiry date']);
    ws.addRow(['Excel Student', 9876500011, new Date(Date.UTC(2026, 6, 1))]);
    const data = Buffer.from(await wb.xlsx.writeBuffer());
    const ctx = ctxFor(admin);
    const draft = await imports.createDraft(ctx, { filename: 'leads.xlsx', mimeType: '', data });
    expect(draft.suggested).toMatchObject({ name: 0, phone: 1, enquiryDate: 2 });
    await imports.startValidation(ctx, draft.id, {
      mapping: draft.suggested as Record<string, number>,
      defaultSourceId: website.id,
      duplicateMode: 'skip',
      roundRobin: false,
    });
    await imports.startRun(ctx, draft.id, 'skip');
    const s = await ownerDb().student.findFirstOrThrow({
      where: { tenantId: tenant.id, phoneE164: '+919876500011' },
      include: { leads: true },
    });
    // 1 July 2026 in the agency's time zone (IST) = 30 June 18:30 UTC.
    expect(s.leads[0]!.createdAt.toISOString()).toBe('2026-06-30T18:30:00.000Z');
  });

  it('round-robin spreads unassigned rows across counselors', async () => {
    const counselor2 = await makeUser(tenant.id, 'COUNSELOR', 'c2@imp.test');
    const rows = [
      ['Name', 'Mobile'],
      ...Array.from({ length: 6 }, (_, i) => [`RR ${i}`, `98700000${String(10 + i)}`]),
    ];
    const v = await draftAndValidate(csv(rows), 'rr.csv', { roundRobin: true });
    await imports.startRun(ctxFor(admin), v.id, 'skip');
    const counts = await ownerDb().leadAssignment.groupBy({
      by: ['assigneeId'],
      where: { tenantId: tenant.id, isActive: true },
      _count: { _all: true },
    });
    expect(Object.fromEntries(counts.map((c) => [c.assigneeId, c._count._all]))).toEqual({
      [counselor.id]: 3,
      [counselor2.id]: 3,
    });
  });

  it('validation refuses a mapping without name/phone or with a column used twice', async () => {
    const ctx = ctxFor(admin);
    const draft = await imports.createDraft(ctx, {
      filename: 'x.csv',
      mimeType: 'text/csv',
      data: csv([
        ['A', 'B'],
        ['x', '9876543210'],
      ]),
    });
    expect(
      await code(
        imports.startValidation(ctx, draft.id, {
          mapping: { name: 0 },
          defaultSourceId: website.id,
          duplicateMode: 'skip',
          roundRobin: false,
        }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      await code(
        imports.startValidation(ctx, draft.id, {
          mapping: { name: 0, phone: 0 },
          defaultSourceId: website.id,
          duplicateMode: 'skip',
          roundRobin: false,
        }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(await code(imports.startRun(ctx, draft.id, 'skip'))).toBe('CONFLICT'); // not validated yet
    expect(await code(imports.cancelImport(ctx, draft.id))).toBe('OK');
  });

  it('rejects non-spreadsheets, oversized and empty files; only admins may import', async () => {
    const ctx = ctxFor(admin);
    expect(
      await code(
        imports.createDraft(ctx, {
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          data: Buffer.from('%PDF'),
        }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      await code(
        imports.createDraft(ctx, { filename: 'x.csv', mimeType: 'text/csv', data: Buffer.alloc(0) }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      await code(
        imports.createDraft(ctx, {
          filename: 'x.csv',
          mimeType: 'text/csv',
          data: Buffer.alloc(21 * 1024 * 1024, 0x61),
        }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      await code(
        imports.createDraft(ctxFor(counselor), {
          filename: 'x.csv',
          mimeType: 'text/csv',
          data: csv([['Name'], ['x']]),
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(await code(imports.listImports(ctxFor(telecaller)))).toBe('FORBIDDEN');
  });

  it('another tenant can’t see the import or its files', async () => {
    const v = await draftAndValidate(
      csv([
        ['Name', 'Mobile'],
        ['X', '1'],
      ]),
    );
    const other = await makeTenant('imp2');
    const otherAdmin = await makeUser(other.id, 'TENANT_ADMIN');
    expect(await code(imports.getImport(ctxFor(otherAdmin), v.id))).toBe('NOT_FOUND');
    const parts = urlParts(v.errorReportUrl!);
    expect(await code(openDownload(ctxFor(otherAdmin), parts.id, parts.exp, parts.sig))).toBe('NOT_FOUND');
  });
});
