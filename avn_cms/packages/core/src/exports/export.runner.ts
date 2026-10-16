import { PassThrough } from 'node:stream';

import { withTenant, type Prisma, type RoleCode, type TenantDb } from '@avn-cms/db';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import type { JobPayload } from '../jobs/queue';
import { JobSupersededError } from '../jobs/recovery';
import { buildLeadFilter } from '../leads/lead.service';
import { can, listScope, seesReducedStudentFields } from '../policy/index';
import { leadListQuerySchema, STAGE_LABEL, webLeadListQuerySchema, type ExportFormat } from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { formatPhone } from '../shared/phone';
import { EXPORT_TTL_DAYS, safeCell, saveFile } from '../storage/files';
import { loadSettings } from '../tenants/settings';

export const MAX_EXPORT_ROWS = 200_000;
export const MAX_PDF_ROWS = 5_000;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const PAGE = 2_000;

export interface ExportParams {
  entity: 'leads' | 'web_leads';
  format: ExportFormat;
  filters: Record<string, string>;
  requestedBy: { userId: string; role: RoleCode; impersonatedBy?: string | undefined };
}

type Column = { header: string; width: number; value: (r: Row) => unknown; pdf?: boolean };
type Row = Record<string, unknown>;

function fmtDate(tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  // DD-MM-YYYY HH:MM — the same format the importer reads, so an export can be re-imported.
  return (d: unknown) => (d instanceof Date ? f.format(d).replace(/\//g, '-').replace(',', '') : '');
}

// ── Data sources ─────────────────────────────────────────────────────────────

const leadSelect = {
  id: true,
  createdAt: true,
  stage: true,
  isPotential: true,
  priority: true,
  interestCountry: true,
  interestCourse: true,
  nextCallAt: true,
  lastContactedAt: true,
  source: { select: { label: true } },
  student: {
    select: {
      name: true,
      phoneE164: true,
      altPhoneE164: true,
      parentName: true,
      email: true,
      town: true,
      district: true,
      state: true,
      address: true,
    },
  },
  assignments: {
    where: { isActive: true },
    select: { roleFunction: true, assignee: { select: { name: true } } },
  },
} satisfies Prisma.LeadSelect;

function leadColumns(role: RoleCode, tz: string): Column[] {
  const date = fmtDate(tz);
  const reduced = seesReducedStudentFields(role);
  const owner = (fn: string) => (r: Row) =>
    (r['assignments'] as { roleFunction: string; assignee: { name: string } }[]).find(
      (a) => a.roleFunction === fn,
    )?.assignee.name ?? '';
  const st = (r: Row) => r['student'] as Record<string, string | null>;
  const cols: (Column | false)[] = [
    { header: 'Student name', width: 26, value: (r) => st(r)['name'], pdf: true },
    { header: 'Mobile number', width: 18, value: (r) => formatPhone(st(r)['phoneE164']!), pdf: true },
    {
      header: 'Alternate number',
      width: 18,
      value: (r) => (st(r)['altPhoneE164'] ? formatPhone(st(r)['altPhoneE164']!) : ''),
    },
    { header: 'Parent name', width: 22, value: (r) => st(r)['parentName'] },
    !reduced && { header: 'Email', width: 28, value: (r) => st(r)['email'] },
    { header: 'Town', width: 16, value: (r) => st(r)['town'] },
    { header: 'District', width: 16, value: (r) => st(r)['district'] },
    { header: 'State', width: 16, value: (r) => st(r)['state'], pdf: true },
    !reduced && { header: 'Address', width: 30, value: (r) => st(r)['address'] },
    {
      header: 'Status',
      width: 20,
      value: (r) => STAGE_LABEL[r['stage'] as keyof typeof STAGE_LABEL],
      pdf: true,
    },
    { header: 'Potential', width: 10, value: (r) => (r['isPotential'] ? 'yes' : 'no') },
    { header: 'Priority', width: 10, value: (r) => (r['priority'] === 'HOT' ? 'HOT' : 'Normal') },
    { header: 'Country', width: 16, value: (r) => r['interestCountry'] },
    { header: 'Course', width: 12, value: (r) => r['interestCourse'] },
    { header: 'Source', width: 16, value: (r) => (r['source'] as { label: string }).label, pdf: true },
    { header: 'Counselor', width: 20, value: owner('COUNSELOR'), pdf: true },
    { header: 'Telecaller', width: 20, value: owner('TELECALLER') },
    { header: 'Next call', width: 18, value: (r) => date(r['nextCallAt']), pdf: true },
    { header: 'Last contacted', width: 18, value: (r) => date(r['lastContactedAt']) },
    { header: 'Enquiry date', width: 18, value: (r) => date(r['createdAt']) },
  ];
  return cols.filter((c): c is Column => Boolean(c));
}

const webLeadSelect = {
  id: true,
  createdAt: true,
  submittedAt: true,
  name: true,
  phoneE164: true,
  phoneRaw: true,
  email: true,
  status: true,
  sourceLabel: true,
  city: true,
  neetScore: true,
  interestCountry: true,
  message: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  gclid: true,
  pageUrl: true,
  postSlug: true,
  source: { select: { label: true } },
} satisfies Prisma.WebLeadSelect;

function webLeadColumns(tz: string): Column[] {
  const date = fmtDate(tz);
  return [
    { header: 'Name', width: 26, value: (r) => r['name'], pdf: true },
    {
      header: 'Mobile number',
      width: 18,
      value: (r) => (r['phoneE164'] ? formatPhone(r['phoneE164'] as string) : r['phoneRaw']),
      pdf: true,
    },
    { header: 'Email', width: 28, value: (r) => r['email'] },
    { header: 'Status', width: 12, value: (r) => String(r['status']).toLowerCase(), pdf: true },
    {
      header: 'Source',
      width: 16,
      value: (r) => (r['source'] as { label: string } | null)?.label ?? '',
      pdf: true,
    },
    { header: 'Source as sent', width: 18, value: (r) => r['sourceLabel'] },
    { header: 'City', width: 14, value: (r) => r['city'] },
    { header: 'NEET score', width: 10, value: (r) => r['neetScore'] },
    { header: 'Country', width: 14, value: (r) => r['interestCountry'] },
    { header: 'Message', width: 40, value: (r) => r['message'] },
    { header: 'UTM source', width: 14, value: (r) => r['utmSource'] },
    { header: 'UTM medium', width: 14, value: (r) => r['utmMedium'] },
    { header: 'UTM campaign', width: 18, value: (r) => r['utmCampaign'], pdf: true },
    { header: 'Google click id', width: 20, value: (r) => r['gclid'] },
    { header: 'Page URL', width: 30, value: (r) => r['pageUrl'] },
    { header: 'Blog post', width: 20, value: (r) => r['postSlug'] },
    { header: 'Submitted', width: 18, value: (r) => date(r['submittedAt']), pdf: true },
  ];
}

function webLeadWhere(filters: Record<string, string>): Prisma.WebLeadWhereInput {
  const q = webLeadListQuerySchema.parse({ ...filters, limit: 1 });
  return {
    ...(q.status ? { status: q.status } : {}),
    ...(q.sourceId ? { sourceId: q.sourceId } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { email: { contains: q.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

/** Pages through the rows (keyset on created_at, id) so memory and query time stay bounded. */
async function* rowsOf(tenantId: string, ctx: Ctx, p: ExportParams): AsyncGenerator<Row[]> {
  if (p.entity === 'leads') {
    const q = leadListQuerySchema.parse({ ...p.filters, limit: 1 });
    const where = await withTenant(tenantId, (db) => buildLeadFilter(db, ctx, q));
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const cursor: Prisma.LeadWhereInput = after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {};
      const page: Row[] = await withTenant(tenantId, (db) =>
        db.lead.findMany({
          where: { AND: [where, cursor] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PAGE,
          select: leadSelect,
        }),
      );
      if (page.length === 0) return;
      yield page;
      const last = page[page.length - 1]!;
      after = { createdAt: last['createdAt'] as Date, id: last['id'] as string };
      if (page.length < PAGE) return;
    }
  } else {
    const where = webLeadWhere(p.filters);
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const cursor: Prisma.WebLeadWhereInput = after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {};
      const page: Row[] = await withTenant(tenantId, (db) =>
        db.webLead.findMany({
          where: { AND: [where, cursor] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PAGE,
          select: webLeadSelect,
        }),
      );
      if (page.length === 0) return;
      yield page;
      const last = page[page.length - 1]!;
      after = { createdAt: last['createdAt'] as Date, id: last['id'] as string };
      if (page.length < PAGE) return;
    }
  }
}

async function countOf(tenantId: string, ctx: Ctx, p: ExportParams): Promise<number> {
  if (p.entity === 'leads') {
    const q = leadListQuerySchema.parse({ ...p.filters, limit: 1 });
    return withTenant(tenantId, async (db) => db.lead.count({ where: await buildLeadFilter(db, ctx, q) }));
  }
  return withTenant(tenantId, (db) => db.webLead.count({ where: webLeadWhere(p.filters) }));
}

// ── Writers ──────────────────────────────────────────────────────────────────

async function writeCsv(
  pages: AsyncGenerator<Row[]>,
  cols: Column[],
): Promise<{ data: Buffer; rows: number }> {
  const chunks: Buffer[] = [Buffer.from(`\uFEFF${stringify([cols.map((c) => c.header)])}`, 'utf8')];
  let rows = 0;
  for await (const page of pages) {
    chunks.push(Buffer.from(stringify(page.map((r) => cols.map((c) => safeCell(c.value(r))))), 'utf8'));
    rows += page.length;
  }
  return { data: Buffer.concat(chunks), rows };
}

async function writeXlsx(
  pages: AsyncGenerator<Row[]>,
  cols: Column[],
  sheetName: string,
): Promise<{ data: Buffer; rows: number }> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true });
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();
  let rows = 0;
  for await (const page of pages) {
    for (const r of page) ws.addRow(cols.map((c) => safeCell(c.value(r)))).commit();
    rows += page.length;
  }
  ws.commit();
  await wb.commit();
  return { data: Buffer.concat(chunks), rows };
}

async function writePdf(
  pages: AsyncGenerator<Row[]>,
  allCols: Column[],
  title: string,
  subtitle: string,
): Promise<{ data: Buffer; rows: number }> {
  const cols = allCols.filter((c) => c.pdf);
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 36,
    info: { Title: title, Producer: 'aVn CMS' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  const totalWidth = doc.page.width - 72;
  const weight = cols.reduce((a, c) => a + c.width, 0);
  const widths = cols.map((c) => (c.width / weight) * totalWidth);
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#111827');
    let x = 36;
    const y = doc.y;
    cols.forEach((c, i) => {
      doc.text(c.header, x, y, { width: widths[i]! - 4, ellipsis: true, lineBreak: false });
      x += widths[i]!;
    });
    doc
      .moveTo(36, y + 12)
      .lineTo(36 + totalWidth, y + 12)
      .lineWidth(0.5)
      .strokeColor('#d5dae1')
      .stroke();
    doc.y = y + 16;
  };
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text(title);
  doc.font('Helvetica').fontSize(9).fillColor('#5b6474').text(subtitle);
  doc.moveDown(0.8);
  header();
  let rows = 0;
  for await (const page of pages) {
    for (const r of page) {
      if (doc.y > doc.page.height - 48) {
        doc.addPage();
        header();
      }
      doc.font('Helvetica').fontSize(8).fillColor('#111827');
      let x = 36;
      const y = doc.y;
      cols.forEach((c, i) => {
        // Helvetica covers Latin text; other scripts are shown as "?" (CSV/XLSX keep them exactly).
        const v = String(c.value(r) ?? '')
          .replace(/\s+/g, ' ')
          .replace(/[^ -ɏ]/g, '?');
        doc.text(v, x, y, { width: widths[i]! - 4, ellipsis: true, lineBreak: false });
        x += widths[i]!;
      });
      doc.y = y + 13;
      rows++;
    }
  }
  doc.end();
  await done;
  return { data: Buffer.concat(chunks), rows };
}

// ── Job ──────────────────────────────────────────────────────────────────────

async function setJob(
  tenantId: string,
  jobId: string,
  data: Prisma.ExportJobUpdateManyMutationInput,
  status?: 'QUEUED' | 'RUNNING',
) {
  return withTenant(tenantId, (db) =>
    db.exportJob.updateMany({ where: { id: jobId, ...(status ? { status } : {}) }, data }),
  );
}

/**
 * Renews the job's heartbeat before each page of rows is handed on. If recovery failed the job
 * while we were still working, stop instead of writing a file nobody is waiting for.
 */
async function* withHeartbeat(
  tenantId: string,
  jobId: string,
  pages: AsyncGenerator<Row[]>,
): AsyncGenerator<Row[]> {
  for await (const page of pages) {
    const alive = await setJob(tenantId, jobId, { heartbeatAt: new Date() }, 'RUNNING');
    if (alive.count !== 1) throw new JobSupersededError();
    yield page;
  }
}

async function stillAllowed(db: TenantDb, ctx: Ctx): Promise<boolean> {
  if (ctx.impersonatedBy) return true; // super admin sessions are checked when the export is requested
  const user = await db.user.findFirst({
    where: { id: ctx.userId, status: 'ACTIVE', deletedAt: null },
    select: { roleCode: true },
  });
  return Boolean(user && user.roleCode === ctx.role);
}

export async function exportRun({ tenantId, jobId }: JobPayload): Promise<void> {
  const started = Date.now();
  // A job that is already RUNNING belongs to a worker that may have died: recovery
  // (jobs/recovery.ts) fails it once its heartbeat goes quiet. This claim never takes it over.
  const claimed = await setJob(tenantId, jobId, { status: 'RUNNING', heartbeatAt: new Date() }, 'QUEUED');
  if (claimed.count !== 1) return;
  const job = await withTenant(tenantId, (db) => db.exportJob.findFirst({ where: { id: jobId } }));
  const p = job!.params as unknown as ExportParams;
  const ctx: Ctx = {
    tenantId,
    userId: p.requestedBy.userId,
    role: p.requestedBy.role,
    ...(p.requestedBy.impersonatedBy ? { impersonatedBy: p.requestedBy.impersonatedBy } : {}),
  };
  // Only while still RUNNING: recovery may have failed this job already.
  const fail = (error: string) =>
    setJob(tenantId, jobId, { status: 'FAILED', result: { error }, finishedAt: new Date() }, 'RUNNING');
  try {
    // Permissions are re-checked at run time: a user disabled or demoted since asking gets nothing.
    if (!(await withTenant(tenantId, (db) => stillAllowed(db, ctx))) || !can(ctx, 'export:run'))
      return void (await fail('You no longer have permission for this export.'));
    if (p.entity === 'web_leads' && listScope(ctx, 'webLead:view') !== 'tenant')
      return void (await fail('Only admins can export web leads.'));
    const total = await countOf(tenantId, ctx, p);
    if (total > MAX_EXPORT_ROWS)
      return void (await fail(
        `That is ${total.toLocaleString('en-IN')} rows; one export holds at most ${MAX_EXPORT_ROWS.toLocaleString('en-IN')}. Narrow the filters.`,
      ));
    if (p.format === 'pdf' && total > MAX_PDF_ROWS)
      return void (await fail(
        `PDF exports hold at most ${MAX_PDF_ROWS.toLocaleString('en-IN')} rows (this one has ${total.toLocaleString('en-IN')}). Choose CSV or Excel, or narrow the filters.`,
      ));

    const { timezone } = await withTenant(tenantId, (db) => loadSettings(db));
    const tenant = await withTenant(tenantId, (db) => db.tenant.findFirst({ select: { name: true } }));
    const cols = p.entity === 'leads' ? leadColumns(ctx.role, timezone) : webLeadColumns(timezone);
    const label = p.entity === 'leads' ? 'leads' : 'web-leads';
    const stamp = fmtDate(timezone)(new Date()).replace(/[: ]/g, '-');
    const pages = withHeartbeat(tenantId, jobId, rowsOf(tenantId, ctx, p));
    const out =
      p.format === 'csv'
        ? await writeCsv(pages, cols)
        : p.format === 'xlsx'
          ? await writeXlsx(pages, cols, p.entity === 'leads' ? 'Leads' : 'Web leads')
          : await writePdf(
              pages,
              cols,
              `${tenant?.name ?? 'aVn CMS'} — ${p.entity === 'leads' ? 'Leads' : 'Web leads'}`,
              `${total.toLocaleString('en-IN')} rows · generated ${fmtDate(timezone)(new Date())} (${timezone}) by aVn CMS`,
            );
    if (out.data.byteLength > MAX_EXPORT_BYTES)
      return void (await fail('The file would be larger than 50 MB. Narrow the filters.'));
    const mime =
      p.format === 'csv'
        ? 'text/csv'
        : p.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf';
    const filename = `${label}-${stamp}.${p.format}`;
    await withTenant(tenantId, async (db) => {
      const fileId = await saveFile(db, {
        purpose: 'EXPORT',
        filename,
        mimeType: mime,
        data: out.data,
        createdById: ctx.userId,
        expiresAt: new Date(Date.now() + EXPORT_TTL_DAYS * 86_400_000),
      });
      const finished = await db.exportJob.updateMany({
        where: { id: jobId, status: 'RUNNING' },
        data: {
          status: 'DONE',
          fileKey: fileId,
          finishedAt: new Date(),
          result: {
            rows: out.rows,
            filename,
            sizeBytes: out.data.byteLength,
            durationMs: Date.now() - started,
          },
        },
      });
      // Rolls back the saved file too.
      if (finished.count !== 1) throw new JobSupersededError();
      await audit(db, ctx, 'export.run', 'export_job', jobId, undefined, {
        entity: p.entity,
        format: p.format,
        rows: out.rows,
        filters: p.filters,
      });
    });
  } catch (err) {
    if (err instanceof JobSupersededError) {
      console.error(
        JSON.stringify({ level: 'warn', msg: 'export stopped: recovery had already failed it', jobId }),
      );
      return;
    }
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'export failed',
        jobId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    await fail('The export failed. Try again; if it keeps failing, contact your admin.');
  }
}
