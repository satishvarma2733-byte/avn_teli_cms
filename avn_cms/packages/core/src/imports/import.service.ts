import { withTenant, type Prisma } from '@avn-cms/db';
import { stringify } from 'csv-stringify/sync';

import { enqueue } from '../jobs/queue';
import { authorize } from '../policy/index';
import type { ImportOptions } from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, invalid, notFound } from '../shared/errors';
import { MAX_FILE_BYTES, saveFile, signedDownloadPath } from '../storage/files';
import { IMPORT_FIELDS, suggestMapping, type ColumnMapping } from './fields';
import type { ImportParams, ImportResult } from './import.runner';
import { parseSheet, sheetKind } from './parse';

/**
 * The import wizard (DEVELOPMENT_PHASES Phase 6): upload → map columns → validate (dry run) →
 * review problems → choose duplicate behaviour → background import → results. Admins only.
 */
const UPLOAD_TTL_DAYS = 30;

function view(
  ctx: Ctx,
  job: {
    id: string;
    status: string;
    params: Prisma.JsonValue;
    result: Prisma.JsonValue;
    createdAt: Date;
    finishedAt: Date | null;
    requestedById: string;
  },
) {
  const p = job.params as unknown as ImportParams;
  const r = (job.result ?? {}) as ImportResult;
  return {
    id: job.id,
    status: job.status,
    filename: p.filename,
    headers: p.headers,
    rowCount: p.rowCount,
    sample: p.sample,
    suggested: p.suggested,
    options: p.options ?? null,
    result: r,
    errorReportUrl: r.errorReportFileId ? signedDownloadPath(r.errorReportFileId, ctx.userId) : null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}
export type ImportView = ReturnType<typeof view>;

export async function createDraft(ctx: Ctx, file: { filename: string; mimeType: string; data: Buffer }) {
  authorize(ctx, 'import:run');
  if (file.data.byteLength === 0) throw invalid('The file is empty.');
  if (file.data.byteLength > MAX_FILE_BYTES)
    throw invalid(`Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const kind = sheetKind(file.filename, file.mimeType);
  if (!kind) throw invalid('Upload a .csv or .xlsx file.');
  const sheet = await parseSheet(file.data, kind);
  return withTenant(ctx.tenantId, async (db) => {
    const fileId = await saveFile(db, {
      purpose: 'IMPORT_UPLOAD',
      filename: file.filename,
      mimeType:
        kind === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: file.data,
      createdById: ctx.userId,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_DAYS * 86_400_000),
    });
    const params: ImportParams = {
      filename: file.filename.slice(0, 200),
      fileId,
      kind,
      headers: sheet.headers,
      rowCount: sheet.rows.length,
      sample: sheet.rows.slice(0, 5),
      suggested: suggestMapping(sheet.headers),
      requestedBy: {
        userId: ctx.userId,
        role: ctx.role,
        ...(ctx.impersonatedBy ? { impersonatedBy: ctx.impersonatedBy } : {}),
      },
    };
    const job = await db.importJob.create({
      data: {
        requestedById: ctx.userId,
        type: 'students',
        status: 'DRAFT',
        params: params as unknown as Prisma.InputJsonValue,
      } as Prisma.ImportJobUncheckedCreateInput,
    });
    await audit(db, ctx, 'import.upload', 'import_job', job.id, undefined, {
      filename: params.filename,
      rows: params.rowCount,
    });
    return view(ctx, job);
  });
}

export async function getImport(ctx: Ctx, id: string) {
  authorize(ctx, 'import:run');
  const job = await withTenant(ctx.tenantId, (db) => db.importJob.findFirst({ where: { id } }));
  if (!job) throw notFound('Import');
  return view(ctx, job);
}

export async function listImports(ctx: Ctx) {
  authorize(ctx, 'import:run');
  return withTenant(ctx.tenantId, async (db) => {
    const jobs = await db.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    const names = new Map(
      (
        await db.user.findMany({
          where: { id: { in: [...new Set(jobs.map((j) => j.requestedById))] } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u.name]),
    );
    return jobs.map((j) => {
      const v = view(ctx, j);
      return {
        id: v.id,
        status: v.status,
        filename: v.filename,
        rowCount: v.rowCount,
        result: v.result,
        createdAt: v.createdAt,
        finishedAt: v.finishedAt,
        requestedBy: names.get(j.requestedById) ?? 'Platform admin',
      };
    });
  });
}

/** Check the mapping, store the options, and start the dry run. */
export async function startValidation(ctx: Ctx, id: string, options: ImportOptions) {
  authorize(ctx, 'import:run');
  return withTenant(ctx.tenantId, async (db) => {
    const job = await db.importJob.findFirst({ where: { id } });
    if (!job) throw notFound('Import');
    if (!['DRAFT', 'VALIDATED', 'FAILED'].includes(job.status))
      throw conflict('This import is already running or finished.');
    const p = job.params as unknown as ImportParams;
    const known = new Set<string>(IMPORT_FIELDS.map((f) => f.key));
    const mapping: ColumnMapping = {};
    const used = new Map<number, string>();
    for (const [field, col] of Object.entries(options.mapping)) {
      if (!known.has(field)) throw invalid(`Unknown field “${field}”.`);
      if (col === null) continue;
      if (col >= p.headers.length) throw invalid(`Column ${col + 1} doesn't exist in this file.`);
      if (used.has(col))
        throw invalid(`“${p.headers[col]}” is mapped to two fields.`, {
          fields: { [field]: 'Column already used.' },
        });
      used.set(col, field);
      mapping[field as keyof ColumnMapping] = col;
    }
    if (mapping.name === undefined || mapping.phone === undefined) {
      throw invalid('Map a column to Student name and to Mobile number.', {
        fields: {
          ...(mapping.name === undefined ? { name: 'Required' } : {}),
          ...(mapping.phone === undefined ? { phone: 'Required' } : {}),
        },
      });
    }
    if (!(await db.leadSource.findFirst({ where: { id: options.defaultSourceId } }))) {
      throw invalid('Choose a default source.', { fields: { defaultSourceId: 'Unknown source.' } });
    }
    const params: ImportParams = { ...p, options: { ...options, mapping } };
    await db.importJob.updateMany({
      where: { id },
      data: {
        status: 'VALIDATING',
        params: params as unknown as Prisma.InputJsonValue,
        // Starting (or starting over): forget the previous attempt, and start the heartbeat clock.
        result: {},
        finishedAt: null,
        heartbeatAt: new Date(),
      },
    });
    return { id };
  }).then(async (r) => {
    await enqueue('import.validate', { tenantId: ctx.tenantId, jobId: id });
    return r;
  });
}

/** Start the real import with the chosen duplicate behaviour (only after a dry run). */
export async function startRun(ctx: Ctx, id: string, duplicateMode: ImportOptions['duplicateMode']) {
  authorize(ctx, 'import:run');
  await withTenant(ctx.tenantId, async (db) => {
    const job = await db.importJob.findFirst({ where: { id } });
    if (!job) throw notFound('Import');
    if (job.status !== 'VALIDATED')
      throw conflict('Check the file first (validation), then start the import.');
    const p = job.params as unknown as ImportParams;
    const params: ImportParams = { ...p, options: { ...p.options!, duplicateMode } };
    const res = await db.importJob.updateMany({
      where: { id, status: 'VALIDATED' },
      data: { status: 'QUEUED', params: params as unknown as Prisma.InputJsonValue },
    });
    if (res.count !== 1) throw conflict('This import was already started.');
    await audit(db, ctx, 'import.start', 'import_job', id, undefined, { duplicateMode });
  });
  await enqueue('import.run', { tenantId: ctx.tenantId, jobId: id });
  return { id };
}

export async function cancelImport(ctx: Ctx, id: string) {
  authorize(ctx, 'import:run');
  return withTenant(ctx.tenantId, async (db) => {
    const res = await db.importJob.updateMany({
      where: { id, status: { in: ['DRAFT', 'VALIDATED', 'FAILED'] } },
      data: { status: 'CANCELED', finishedAt: new Date() },
    });
    if (res.count !== 1) throw conflict('Only an import that hasn’t started can be canceled.');
    await audit(db, ctx, 'import.cancel', 'import_job', id);
    return { id };
  });
}

/** Downloadable CSV template (one example row, TEST DATA). */
export function templateCsv(): string {
  const headers = [
    'Student name',
    'Mobile number',
    'Parent name',
    'Email',
    'Town',
    'District',
    'State',
    'Source',
    'Status',
    'Country',
    'Course',
    'NEET score',
    'Counselor',
    'Telecaller',
    'Potential',
    'Priority',
    'Next call',
    'Enquiry date',
    'Notes',
  ];
  const example = [
    'Sample Student',
    '9876543210',
    'Sample Parent',
    'sample@example.test',
    'Guntur',
    'Guntur',
    'Andhra Pradesh',
    'Website',
    'Interested',
    'Georgia',
    'MBBS',
    '520',
    'counselor@yourdomain.test',
    '',
    'yes',
    'HOT',
    '20-10-2026 11:00',
    '15-10-2026',
    'Called from the Diwali campaign',
  ];
  return `\uFEFF${stringify([headers, example])}`;
}
