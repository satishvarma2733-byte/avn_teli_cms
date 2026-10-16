import {
  withTenant,
  type CallDisposition,
  type LeadStage,
  type Prisma,
  type RoleCode,
  type TenantDb,
} from '@avn-cms/db';
import { stringify } from 'csv-stringify/sync';

import { setAssignment } from '../assignments/assignment.repository';
import type { JobPayload } from '../jobs/queue';
import {
  CLOSED_STAGES,
  DISPOSITION_LABEL,
  STAGE_LABEL,
  type DuplicateMode,
  type ImportOptions,
} from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { readFile, safeCell, saveFile } from '../storage/files';
import { loadSettings } from '../tenants/settings';
import type { ColumnMapping } from './fields';
import { normalizeRow, type ImportCandidate, type RowContext, type RowIssue } from './normalize';
import { parseSheet, type SheetKind } from './parse';

/** Rows written per transaction. */
export const BATCH_SIZE = 500;
const ERROR_REPORT_TTL_DAYS = 30;
const CONNECTED: CallDisposition[] = [
  'COMPLETED',
  'INTERESTED',
  'NOT_INTERESTED',
  'CALL_BACK_LATER',
  'AWAITING_FEEDBACK',
];

export interface ImportParams {
  filename: string;
  fileId: string;
  kind: SheetKind;
  headers: string[];
  rowCount: number;
  sample: string[][];
  suggested: ColumnMapping;
  requestedBy: { userId: string; role: RoleCode; impersonatedBy?: string | undefined };
  options?: ImportOptions;
}

export interface ImportResult {
  total?: number;
  valid?: number;
  invalid?: number;
  warnings?: number;
  duplicatesInFile?: number;
  existing?: number;
  newRows?: number;
  issuesSample?: RowIssue[];
  errorReportFileId?: string | null;
  processed?: number;
  created?: number;
  updated?: number;
  merged?: number;
  skipped?: number;
  failed?: number;
  durationMs?: number;
  error?: string;
}

const actorCtx = (tenantId: string, p: ImportParams): Ctx => ({
  tenantId,
  userId: p.requestedBy.userId,
  role: p.requestedBy.role,
  ...(p.requestedBy.impersonatedBy ? { impersonatedBy: p.requestedBy.impersonatedBy } : {}),
});

async function loadJob(tenantId: string, jobId: string) {
  const job = await withTenant(tenantId, (db) => db.importJob.findFirst({ where: { id: jobId } }));
  if (!job) throw new Error(`import job ${jobId} not found`);
  return { job, params: job.params as unknown as ImportParams };
}

async function setJob(
  tenantId: string,
  jobId: string,
  data: Prisma.ImportJobUpdateManyMutationInput,
  whereStatus?: Prisma.ImportJobWhereInput['status'],
) {
  return withTenant(tenantId, (db) =>
    db.importJob.updateMany({ where: { id: jobId, ...(whereStatus ? { status: whereStatus } : {}) }, data }),
  );
}

async function rowContext(db: TenantDb, options: ImportOptions): Promise<RowContext> {
  const { timezone } = await loadSettings(db);
  const sources = await db.leadSource.findMany({ select: { id: true, code: true, label: true } });
  const users = await db.user.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      roleCode: { in: ['TENANT_ADMIN', 'COUNSELOR', 'TELECALLER'] },
    },
    select: { id: true, name: true, email: true, roleCode: true },
  });
  const counselors = new Map<string, { id: string; name: string }>();
  const telecallers = new Map<string, { id: string; name: string }>();
  for (const u of users) {
    const target = u.roleCode === 'TELECALLER' ? telecallers : counselors;
    target.set(u.email.toLowerCase(), u);
    if (!target.has(u.name.toLowerCase())) target.set(u.name.toLowerCase(), u);
  }
  return { timezone, defaultSourceId: options.defaultSourceId, sources, counselors, telecallers };
}

interface Analysed {
  candidates: { line: number; c: ImportCandidate }[];
  issues: RowIssue[];
  invalid: number;
  duplicatesInFile: number;
  rows: string[][];
  headers: string[];
}

/** Parse + normalise every row; later rows repeating a phone in the same file are skipped. */
async function analyse(tenantId: string, params: ImportParams): Promise<Analysed> {
  const options = params.options!;
  const file = await withTenant(tenantId, (db) => readFile(db, params.fileId));
  if (!file) throw new Error('The uploaded file is no longer available. Upload it again.');
  const sheet = await parseSheet(Buffer.from(file.data), params.kind);
  const ctx = await withTenant(tenantId, (db) => rowContext(db, options));
  const mapping = Object.fromEntries(
    Object.entries(options.mapping).filter(([, v]) => v !== null),
  ) as ColumnMapping;
  const seen = new Map<string, number>();
  const out: Analysed = {
    candidates: [],
    issues: [],
    invalid: 0,
    duplicatesInFile: 0,
    rows: sheet.rows,
    headers: sheet.headers,
  };
  sheet.rows.forEach((cells, i) => {
    const line = i + 2;
    const r = normalizeRow(cells, line, mapping, ctx);
    out.issues.push(...r.issues);
    if (!r.candidate) {
      out.invalid++;
      return;
    }
    const first = seen.get(r.candidate.phoneE164);
    if (first !== undefined) {
      out.duplicatesInFile++;
      out.issues.push({
        line,
        severity: 'warning',
        field: 'phone',
        message: `Same mobile number as line ${first}; skipped.`,
      });
      return;
    }
    seen.set(r.candidate.phoneE164, line);
    out.candidates.push({ line, c: r.candidate });
  });
  return out;
}

async function existingPhones(tenantId: string, phones: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < phones.length; i += 1000) {
    const chunk = phones.slice(i, i + 1000);
    const rows = await withTenant(tenantId, (db) =>
      db.student.findMany({
        where: { phoneE164: { in: chunk }, deletedAt: null },
        select: { phoneE164: true },
      }),
    );
    for (const r of rows) found.add(r.phoneE164);
  }
  return found;
}

async function writeErrorReport(
  tenantId: string,
  params: ImportParams,
  issues: RowIssue[],
  headers: string[],
  rows: string[][],
): Promise<string | null> {
  if (issues.length === 0) return null;
  const sorted = [...issues].sort(
    (a, b) => a.line - b.line || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1),
  );
  const records = sorted.map((i) => [
    String(i.line),
    i.severity,
    i.field,
    i.message,
    ...(rows[i.line - 2] ?? []).map(safeCell),
  ]);
  const csv = stringify([['Line', 'Severity', 'Field', 'Problem', ...headers.map(safeCell)], ...records]);
  const base = params.filename.replace(/\.[^.]+$/, '');
  return withTenant(tenantId, (db) =>
    saveFile(db, {
      purpose: 'IMPORT_ERRORS',
      filename: `${base}-problems.csv`,
      mimeType: 'text/csv',
      data: Buffer.from(`\uFEFF${csv}`, 'utf8'),
      createdById: params.requestedBy.userId,
      expiresAt: new Date(Date.now() + ERROR_REPORT_TTL_DAYS * 86_400_000),
    }),
  );
}

// ── Dry run ──────────────────────────────────────────────────────────────────

export async function validateImport({ tenantId, jobId }: JobPayload): Promise<void> {
  const started = Date.now();
  const { job, params } = await loadJob(tenantId, jobId);
  if (job.status !== 'VALIDATING') return;
  try {
    const a = await analyse(tenantId, params);
    const existing = await existingPhones(
      tenantId,
      a.candidates.map((x) => x.c.phoneE164),
    );
    const errorReportFileId = await writeErrorReport(tenantId, params, a.issues, a.headers, a.rows);
    const result: ImportResult = {
      total: a.rows.length,
      valid: a.candidates.length,
      invalid: a.invalid,
      warnings: a.issues.filter((i) => i.severity === 'warning').length,
      duplicatesInFile: a.duplicatesInFile,
      existing: existing.size,
      newRows: a.candidates.length - existing.size,
      issuesSample: a.issues.slice(0, 100),
      errorReportFileId,
      durationMs: Date.now() - started,
    };
    await setJob(
      tenantId,
      jobId,
      { status: 'VALIDATED', result: result as Prisma.InputJsonValue },
      'VALIDATING',
    );
  } catch (err) {
    await setJob(tenantId, jobId, {
      status: 'FAILED',
      result: { error: messageOf(err) },
      finishedAt: new Date(),
    });
  }
}

// ── Real run ─────────────────────────────────────────────────────────────────

interface Counts {
  created: number;
  updated: number;
  merged: number;
  skipped: number;
  failed: number;
}

/** Counselors in round-robin order (least recently picked first); rotated in memory. */
async function roundRobinPool(db: TenantDb): Promise<string[]> {
  const rows = await db.user.findMany({
    where: { status: 'ACTIVE', deletedAt: null, roleCode: 'COUNSELOR' },
    orderBy: [{ lastRoundRobinAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

const leadNote = (c: ImportCandidate): string | null => (c.noteLines.length ? c.noteLines.join('\n') : null);

async function createNew(
  db: TenantDb,
  ctx: Ctx,
  params: ImportParams,
  rows: { line: number; c: ImportCandidate }[],
  rr: () => string | null,
) {
  if (rows.length === 0) return { created: 0, raced: [] as { line: number; c: ImportCandidate }[] };
  const now = new Date();
  const students = await db.student.createManyAndReturn({
    data: rows.map(({ c }) => ({
      name: c.name,
      parentName: c.parentName,
      phoneRaw: c.phoneRaw,
      phoneE164: c.phoneE164,
      altPhoneE164: c.altPhoneE164,
      email: c.email,
      town: c.town,
      district: c.district,
      state: c.state,
      address: c.address,
      createdById: ctx.userId,
      createdAt: c.enquiryDate ?? now,
    })) as Prisma.StudentCreateManyInput[],
    skipDuplicates: true,
    select: { id: true, phoneE164: true },
  });
  const byPhone = new Map(students.map((s) => [s.phoneE164, s.id]));
  const made = rows.filter((r) => byPhone.has(r.c.phoneE164));
  const raced = rows.filter((r) => !byPhone.has(r.c.phoneE164)); // created by someone else meanwhile

  const counselorFor = new Map<string, string | null>();
  for (const r of made)
    counselorFor.set(r.c.phoneE164, r.c.counselorId ?? (params.options!.roundRobin ? rr() : null));

  const leads = await db.lead.createManyAndReturn({
    data: made.map(({ c }) => ({
      studentId: byPhone.get(c.phoneE164)!,
      sourceId: c.sourceId,
      stage: c.stage ?? 'NEW',
      isPotential: c.isPotential ?? c.stage === 'POTENTIAL',
      priority: c.priority ?? 'NORMAL',
      interestCountry: c.interestCountry,
      interestCourse: c.interestCourse,
      nextCallAt: c.nextCallAt,
      lastContactedAt:
        (c.stage && c.stage !== 'NEW') || (c.disposition && CONNECTED.includes(c.disposition))
          ? (c.enquiryDate ?? now)
          : null,
      createdAt: c.enquiryDate ?? now,
    })) as Prisma.LeadCreateManyInput[],
    select: { id: true, studentId: true },
  });
  const leadOf = new Map(leads.map((l) => [l.studentId, l.id]));
  const ids = made.map(({ line, c }) => ({
    line,
    c,
    studentId: byPhone.get(c.phoneE164)!,
    leadId: leadOf.get(byPhone.get(c.phoneE164)!)!,
  }));

  const history: Prisma.LeadStatusHistoryCreateManyInput[] = [];
  const assignments: Prisma.LeadAssignmentCreateManyInput[] = [];
  const followUps: Prisma.FollowUpCreateManyInput[] = [];
  const notes: Prisma.NoteCreateManyInput[] = [];
  const activities: Prisma.ActivityCreateManyInput[] = [];
  for (const { line, c, studentId, leadId } of ids) {
    const at = c.enquiryDate ?? now;
    history.push({
      leadId,
      fromStage: null,
      toStage: 'NEW',
      changedById: ctx.userId,
      note: `Imported from ${params.filename}`,
      createdAt: at,
    } as Prisma.LeadStatusHistoryCreateManyInput);
    if (c.stage && c.stage !== 'NEW') {
      history.push({
        leadId,
        fromStage: 'NEW',
        toStage: c.stage,
        changedById: ctx.userId,
        note: 'Status from the imported file',
        createdAt: at,
      } as Prisma.LeadStatusHistoryCreateManyInput);
    }
    const counselorId = counselorFor.get(c.phoneE164) ?? null;
    if (counselorId)
      assignments.push({
        leadId,
        assigneeId: counselorId,
        roleFunction: 'COUNSELOR',
        assignedById: ctx.userId,
      } as Prisma.LeadAssignmentCreateManyInput);
    if (c.telecallerId)
      assignments.push({
        leadId,
        assigneeId: c.telecallerId,
        roleFunction: 'TELECALLER',
        assignedById: ctx.userId,
      } as Prisma.LeadAssignmentCreateManyInput);
    if (c.nextCallAt) {
      followUps.push({
        leadId,
        scheduledAt: c.nextCallAt,
        assigneeId: c.telecallerId ?? counselorId ?? ctx.userId,
        priority: c.priority ?? 'NORMAL',
        createdById: ctx.userId,
      } as Prisma.FollowUpCreateManyInput);
    }
    const note = leadNote(c);
    if (note) notes.push({ leadId, authorId: ctx.userId, body: note } as Prisma.NoteCreateManyInput);
    activities.push({
      studentId,
      leadId,
      type: 'SYSTEM',
      actorId: ctx.userId,
      summary: `Imported from ${params.filename} (line ${line})`,
      payload: { line },
    } as unknown as Prisma.ActivityCreateManyInput);
    if (c.disposition) {
      activities.push({
        studentId,
        leadId,
        type: 'CALL',
        actorId: ctx.userId,
        direction: 'OUT',
        summary: `Call outcome from the old system: ${DISPOSITION_LABEL[c.disposition]}`,
        payload: { disposition: c.disposition, imported: true },
      } as unknown as Prisma.ActivityCreateManyInput);
    }
    if (note)
      activities.push({
        studentId,
        leadId,
        type: 'NOTE',
        actorId: ctx.userId,
        summary: note.slice(0, 500),
      } as unknown as Prisma.ActivityCreateManyInput);
  }
  if (history.length) await db.leadStatusHistory.createMany({ data: history });
  if (assignments.length) await db.leadAssignment.createMany({ data: assignments });
  if (followUps.length) await db.followUp.createMany({ data: followUps });
  if (notes.length) await db.note.createMany({ data: notes });
  if (activities.length) await db.activity.createMany({ data: activities });
  return { created: made.length, raced };
}

const STUDENT_FIELDS = [
  'name',
  'parentName',
  'altPhoneE164',
  'email',
  'town',
  'district',
  'state',
  'address',
] as const;

/** update = imported non-empty values win; merge = only fill what is empty. */
async function applyExisting(
  db: TenantDb,
  ctx: Ctx,
  params: ImportParams,
  line: number,
  c: ImportCandidate,
  mode: Exclude<DuplicateMode, 'skip'>,
) {
  const student = await db.student.findFirst({
    where: { phoneE164: c.phoneE164, deletedAt: null },
    include: {
      leads: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: { assignments: { where: { isActive: true } } },
      },
    },
  });
  if (!student) return false;
  const data: Record<string, unknown> = {};
  for (const f of STUDENT_FIELDS) {
    const incoming = c[f];
    if (incoming === null || incoming === undefined || incoming === '') continue;
    const current = (student as Record<string, unknown>)[f];
    if (mode === 'update' ? incoming !== current : current === null || current === '') data[f] = incoming;
  }
  if (Object.keys(data).length) await db.student.updateMany({ where: { id: student.id }, data });

  let lead = student.leads.find((l) => !CLOSED_STAGES.includes(l.stage)) ?? student.leads[0];
  if (!lead) {
    const created = await db.lead.create({
      data: {
        studentId: student.id,
        sourceId: c.sourceId,
        stage: c.stage ?? 'NEW',
        interestCountry: c.interestCountry,
        interestCourse: c.interestCourse,
      } as Prisma.LeadUncheckedCreateInput,
      include: { assignments: { where: { isActive: true } } },
    });
    await db.leadStatusHistory.create({
      data: {
        leadId: created.id,
        fromStage: null,
        toStage: created.stage,
        changedById: ctx.userId,
        note: `Imported from ${params.filename}`,
      } as Prisma.LeadStatusHistoryUncheckedCreateInput,
    });
    lead = created;
  }
  const leadData: Prisma.LeadUpdateManyMutationInput = {};
  if (c.interestCountry && (mode === 'update' || !lead.interestCountry))
    leadData.interestCountry = c.interestCountry;
  if (c.interestCourse && (mode === 'update' || !lead.interestCourse))
    leadData.interestCourse = c.interestCourse;
  if (c.isPotential !== null && (mode === 'update' || c.isPotential)) leadData.isPotential = c.isPotential;
  if (c.priority && (mode === 'update' || c.priority === 'HOT')) leadData.priority = c.priority;
  const stageChange: LeadStage | null =
    mode === 'update' && c.stage && c.stage !== lead.stage ? c.stage : null;
  if (stageChange) leadData.stage = stageChange;
  if (Object.keys(leadData).length) await db.lead.updateMany({ where: { id: lead.id }, data: leadData });
  if (stageChange) {
    await db.leadStatusHistory.create({
      data: {
        leadId: lead.id,
        fromStage: lead.stage,
        toStage: stageChange,
        changedById: ctx.userId,
        note: `Updated by import of ${params.filename}`,
      } as Prisma.LeadStatusHistoryUncheckedCreateInput,
    });
  }
  const has = (fn: 'COUNSELOR' | 'TELECALLER') => lead.assignments.some((a) => a.roleFunction === fn);
  if (c.counselorId && (mode === 'update' || !has('COUNSELOR')))
    await setAssignment(db, lead.id, 'COUNSELOR', c.counselorId, ctx.userId);
  if (c.telecallerId && (mode === 'update' || !has('TELECALLER')))
    await setAssignment(db, lead.id, 'TELECALLER', c.telecallerId, ctx.userId);
  if (c.nextCallAt) {
    const assigneeId =
      c.telecallerId ??
      lead.assignments.find((a) => a.roleFunction === 'TELECALLER')?.assigneeId ??
      c.counselorId ??
      lead.assignments[0]?.assigneeId ??
      ctx.userId;
    await db.followUp.create({
      data: {
        leadId: lead.id,
        scheduledAt: c.nextCallAt,
        assigneeId,
        createdById: ctx.userId,
      } as Prisma.FollowUpUncheckedCreateInput,
    });
    const next = await db.followUp.findFirst({
      where: { leadId: lead.id, completedAt: null },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });
    await db.lead.updateMany({ where: { id: lead.id }, data: { nextCallAt: next?.scheduledAt ?? null } });
  }
  const note = leadNote(c);
  if (note)
    await db.note.create({
      data: { leadId: lead.id, authorId: ctx.userId, body: note } as Prisma.NoteUncheckedCreateInput,
    });
  const changed = [...Object.keys(data), ...Object.keys(leadData)];
  await db.activity.create({
    data: {
      studentId: student.id,
      leadId: lead.id,
      type: 'SYSTEM',
      actorId: ctx.userId,
      summary: `${mode === 'update' ? 'Updated' : 'Merged'} from ${params.filename} (line ${line})${changed.length ? `: ${changed.join(', ')}` : ', nothing new'}${stageChange ? ` — stage ${STAGE_LABEL[stageChange]}` : ''}`,
      payload: { line, fields: changed },
    } as unknown as Prisma.ActivityUncheckedCreateInput,
  });
  return true;
}

async function processBatch(
  tenantId: string,
  ctx: Ctx,
  params: ImportParams,
  batch: { line: number; c: ImportCandidate }[],
  existing: Set<string>,
  mode: DuplicateMode,
  rr: () => string | null,
  counts: Counts,
  failures: RowIssue[],
) {
  const news = batch.filter((r) => !existing.has(r.c.phoneE164));
  const olds = batch.filter((r) => existing.has(r.c.phoneE164));
  const run = (
    rows: { line: number; c: ImportCandidate }[],
    oldRows: { line: number; c: ImportCandidate }[],
  ) =>
    withTenant(
      tenantId,
      async (db) => {
        const local: Counts = { created: 0, updated: 0, merged: 0, skipped: 0, failed: 0 };
        const { created, raced } = await createNew(db, ctx, params, rows, rr);
        local.created += created;
        for (const r of [...oldRows, ...raced]) {
          if (mode === 'skip') {
            local.skipped++;
            continue;
          }
          if (await applyExisting(db, ctx, params, r.line, r.c, mode)) {
            if (mode === 'update') local.updated++;
            else local.merged++;
          } else local.skipped++;
        }
        return local;
      },
      { timeoutMs: 120_000 },
    );
  try {
    const local = await run(news, olds);
    for (const k of Object.keys(counts) as (keyof Counts)[]) counts[k] += local[k];
  } catch {
    // Isolate the bad row(s): retry one row per transaction and report the ones that fail.
    for (const r of batch) {
      try {
        const local = await run(
          existing.has(r.c.phoneE164) ? [] : [r],
          existing.has(r.c.phoneE164) ? [r] : [],
        );
        for (const k of Object.keys(counts) as (keyof Counts)[]) counts[k] += local[k];
      } catch (err) {
        counts.failed++;
        // The report gets a plain message; the database detail goes to the server log only.
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'import row failed',
            fileId: params.fileId,
            line: r.line,
            error: messageOf(err),
          }),
        );
        failures.push({
          line: r.line,
          severity: 'error',
          field: 'row',
          message: 'Could not be saved (the database rejected this row). Check it and import it again.',
        });
      }
    }
  }
}

export async function runImport({ tenantId, jobId }: JobPayload): Promise<void> {
  const started = Date.now();
  const claimed = await setJob(tenantId, jobId, { status: 'RUNNING' }, 'QUEUED');
  if (claimed.count !== 1) return; // already taken or canceled
  const { params } = await loadJob(tenantId, jobId);
  const mode = params.options!.duplicateMode;
  const ctx = actorCtx(tenantId, params);
  try {
    const a = await analyse(tenantId, params);
    const existing = await existingPhones(
      tenantId,
      a.candidates.map((x) => x.c.phoneE164),
    );
    const pool = params.options!.roundRobin ? await withTenant(tenantId, (db) => roundRobinPool(db)) : [];
    let turn = 0;
    const used = new Set<string>();
    const rr = () => {
      if (pool.length === 0) return null;
      const id = pool[turn++ % pool.length]!;
      used.add(id);
      return id;
    };
    const counts: Counts = {
      created: 0,
      updated: 0,
      merged: 0,
      skipped: a.duplicatesInFile,
      failed: a.invalid,
    };
    const failures: RowIssue[] = [];
    for (let i = 0; i < a.candidates.length; i += BATCH_SIZE) {
      await processBatch(
        tenantId,
        ctx,
        params,
        a.candidates.slice(i, i + BATCH_SIZE),
        existing,
        mode,
        rr,
        counts,
        failures,
      );
      await setJob(tenantId, jobId, {
        result: {
          processed: Math.min(i + BATCH_SIZE, a.candidates.length),
          total: a.candidates.length,
          ...counts,
        } as Prisma.InputJsonValue,
      });
    }
    if (used.size) {
      const at = new Date();
      await withTenant(tenantId, (db) =>
        db.user.updateMany({ where: { id: { in: [...used] } }, data: { lastRoundRobinAt: at } }),
      );
    }
    const errorReportFileId = await writeErrorReport(
      tenantId,
      params,
      [...a.issues, ...failures],
      a.headers,
      a.rows,
    );
    const result: ImportResult = {
      total: a.rows.length,
      processed: a.candidates.length,
      ...counts,
      warnings: a.issues.filter((i) => i.severity === 'warning').length,
      duplicatesInFile: a.duplicatesInFile,
      errorReportFileId,
      issuesSample: [...a.issues, ...failures].slice(0, 100),
      durationMs: Date.now() - started,
    };
    await withTenant(tenantId, async (db) => {
      await db.importJob.updateMany({
        where: { id: jobId },
        data: { status: 'DONE', result: result as Prisma.InputJsonValue, finishedAt: new Date() },
      });
      await audit(db, ctx, 'import.run', 'import_job', jobId, undefined, {
        filename: params.filename,
        mode,
        ...counts,
      });
    });
  } catch (err) {
    await setJob(tenantId, jobId, {
      status: 'FAILED',
      result: { error: messageOf(err) },
      finishedAt: new Date(),
    });
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0] ?? err.message;
  return String(err);
}
