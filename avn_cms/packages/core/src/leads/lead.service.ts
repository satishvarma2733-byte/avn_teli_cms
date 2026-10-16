import { withTenant, type LeadStage, type Prisma, type RoleFunction, type TenantDb } from '@avn-cms/db';

import { listTimeline, recordActivity } from '../activities/activity.repository';
import {
  assertAssignable,
  pickRoundRobin,
  setAssignment,
  userNames,
} from '../assignments/assignment.repository';
import { authorize, can, listScope, seesReducedStudentFields, type Action } from '../policy/index';
import {
  CLOSED_STAGES,
  NEGATIVE_STAGES,
  STAGE_LABEL,
  type BulkActionDTO,
  type LeadListQuery,
  type LeadUpdateDTO,
  type StudentCreateDTO,
  type StudentUpdateDTO,
} from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, forbidden, invalid, notFound } from '../shared/errors';
import { decodeKeyset, encodeKeyset, keysetWhere } from '../shared/pagination';
import { toE164 } from '../shared/phone';
import { dayBounds } from '../shared/time';
import { loadSettings } from '../tenants/settings';
import {
  countLeads,
  countStudentsByEmail,
  findLeadForAccess,
  findLeads,
  findSource,
  findStudentByPhone,
  leadDetailRelations,
  type LeadForAccess,
  type LeadListRow,
} from './lead.repository';

// ── Access helpers ───────────────────────────────────────────────────────────

/**
 * Loads a lead and checks `action` on it. A lead the caller can't even read answers 404,
 * not 403, so ids can't be probed (RBAC rule 2).
 */
export async function loadLead(
  db: TenantDb,
  ctx: Ctx,
  leadId: string,
  action: Action,
): Promise<LeadForAccess> {
  const lead = await findLeadForAccess(db, leadId);
  if (!lead || lead.student.deletedAt) throw notFound('Lead');
  const resource = { tenantId: lead.tenantId, assigneeIds: lead.assignments.map((a) => a.assigneeId) };
  if (!can(ctx, 'student:read', resource)) throw notFound('Lead');
  if (action !== 'student:read') authorize(ctx, action, resource);
  return lead;
}

/** Student-level access: the union of assignees across the student's live leads. */
async function loadStudent(db: TenantDb, ctx: Ctx, studentId: string, action: Action) {
  const student = await db.student.findFirst({
    where: { id: studentId, deletedAt: null },
    include: {
      leads: {
        where: { deletedAt: null },
        select: { id: true, assignments: { where: { isActive: true }, select: { assigneeId: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!student) throw notFound('Student');
  const resource = {
    tenantId: student.tenantId,
    assigneeIds: student.leads.flatMap((l) => l.assignments.map((a) => a.assigneeId)),
  };
  if (!can(ctx, 'student:read', resource)) throw notFound('Student');
  if (action !== 'student:read') authorize(ctx, action, resource);
  return student;
}

function ownFilter(ctx: Ctx): Prisma.LeadWhereInput {
  return { assignments: { some: { assigneeId: ctx.userId, isActive: true } } };
}

// ── Serialisation ────────────────────────────────────────────────────────────

function serializeRow(row: LeadListRow, reduced: boolean) {
  const counselor = row.assignments.find((a) => a.roleFunction === 'COUNSELOR')?.assignee ?? null;
  const telecaller = row.assignments.find((a) => a.roleFunction === 'TELECALLER')?.assignee ?? null;
  return {
    id: row.id,
    stage: row.stage,
    isPotential: row.isPotential,
    priority: row.priority,
    interestCountry: row.interestCountry,
    interestCourse: row.interestCourse,
    nextCallAt: row.nextCallAt,
    lastContactedAt: row.lastContactedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    student: {
      id: row.student.id,
      name: row.student.name,
      phone: row.student.phoneE164,
      email: reduced ? null : row.student.email,
      town: row.student.town,
      district: row.student.district,
      state: row.student.state,
    },
    source: row.source,
    counselor,
    telecaller,
  };
}
export type LeadRowDTO = ReturnType<typeof serializeRow>;

// ── List (the workspace table) ───────────────────────────────────────────────

const SORTS = {
  newest: { field: 'createdAt', dir: 'desc' },
  oldest: { field: 'createdAt', dir: 'asc' },
  updated: { field: 'updatedAt', dir: 'desc' },
} as const;

/**
 * The workspace filter (scope + view + filters + search), shared by the list and by exports
 * so an export always contains exactly what the user could see in the table.
 */
export async function buildLeadFilter(
  db: TenantDb,
  ctx: Ctx,
  q: Omit<LeadListQuery, 'cursor' | 'limit' | 'sort'>,
): Promise<Prisma.LeadWhereInput> {
  const scope = listScope(ctx, 'student:list');
  if (!scope) throw forbidden();
  {
    const and: Prisma.LeadWhereInput[] = [{ deletedAt: null, student: { deletedAt: null } }];
    if (scope === 'own') and.push(ownFilter(ctx));

    const settings = await loadSettings(db);
    const now = new Date();
    switch (q.view) {
      case 'mine':
        and.push(ownFilter(ctx));
        break;
      case 'today': {
        const { start, end } = dayBounds(settings.timezone, now);
        and.push({ nextCallAt: { gte: start, lt: end } });
        break;
      }
      case 'overdue':
        and.push({ nextCallAt: { lt: now }, stage: { notIn: CLOSED_STAGES } });
        break;
      case 'potential':
        and.push({ isPotential: true });
        break;
      case 'hot':
        and.push({ priority: 'HOT' });
        break;
      case 'unassigned':
        and.push({ assignments: { none: { isActive: true, roleFunction: 'COUNSELOR' } } });
        break;
      case 'closed':
        and.push({ stage: { in: CLOSED_STAGES } });
        break;
      case 'all':
        break;
    }
    if (q.stage) and.push({ stage: q.stage });
    if (q.sourceId) and.push({ sourceId: q.sourceId });
    if (q.counselorId)
      and.push({
        assignments: { some: { assigneeId: q.counselorId, roleFunction: 'COUNSELOR', isActive: true } },
      });
    if (q.telecallerId)
      and.push({
        assignments: { some: { assigneeId: q.telecallerId, roleFunction: 'TELECALLER', isActive: true } },
      });
    if (q.state) and.push({ student: { state: { equals: q.state, mode: 'insensitive' } } });
    if (q.district) and.push({ student: { district: { equals: q.district, mode: 'insensitive' } } });
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      const or: Prisma.LeadWhereInput[] = [
        { student: { name: { contains: q.q, mode: 'insensitive' } } },
        { student: { parentName: { contains: q.q, mode: 'insensitive' } } },
      ];
      if (digits.length >= 4) or.push({ student: { phoneE164: { contains: digits } } });
      if (q.q.includes('@') && !seesReducedStudentFields(ctx.role))
        or.push({ student: { email: { contains: q.q, mode: 'insensitive' } } });
      and.push({ OR: or });
    }
    return { AND: and };
  }
}

export async function listLeads(ctx: Ctx, q: LeadListQuery) {
  if (!listScope(ctx, 'student:list')) throw forbidden();
  const sort = SORTS[q.sort];
  const cursor = decodeKeyset(q.cursor, q.sort);

  return withTenant(ctx.tenantId, async (db) => {
    const filter = await buildLeadFilter(db, ctx, q);
    const rows = await findLeads(
      db,
      { AND: [filter, keysetWhere(sort.field, sort.dir, cursor)] },
      [{ [sort.field]: sort.dir }, { id: sort.dir }],
      q.limit + 1,
    );
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];
    const total = cursor ? undefined : await countLeads(db, filter);
    const reduced = seesReducedStudentFields(ctx.role);
    return {
      items: items.map((r) => serializeRow(r, reduced)),
      nextCursor: hasMore && last ? encodeKeyset(q.sort, last[sort.field], last.id) : null,
      total,
    };
  });
}

// ── Create (Add Student) ─────────────────────────────────────────────────────

export async function createStudent(ctx: Ctx, dto: StudentCreateDTO) {
  authorize(ctx, 'student:create');
  const phoneE164 = toE164(dto.phone);
  if (!phoneE164)
    throw invalid('Enter a valid mobile number.', {
      fields: { phone: 'Enter a valid mobile number (10 digits for India).' },
    });
  const altPhoneE164 = dto.altPhone ? toE164(dto.altPhone) : null;
  if (dto.altPhone && !altPhoneE164)
    throw invalid('Enter a valid alternate number.', {
      fields: { altPhone: 'Enter a valid mobile number.' },
    });

  // Only admins pick the counselor; a counselor creating a student owns it (RBAC "auto-assigned self").
  if (ctx.role !== 'TENANT_ADMIN' && dto.counselorId && dto.counselorId !== ctx.userId)
    throw forbidden('Only an admin can assign another counselor.');

  return withTenant(ctx.tenantId, async (db) => {
    const existing = await findStudentByPhone(db, phoneE164);
    if (existing) {
      throw conflict('A student with this phone number already exists.', {
        fields: { phone: 'This number already belongs to a student.' },
        studentId: existing.id,
        leadId: existing.leads[0]?.id ?? null,
        name: can(ctx, 'student:read') ? existing.name : undefined,
      });
    }
    const source = await findSource(db, dto.sourceId);
    if (!source) throw invalid('Choose a lead source.', { fields: { sourceId: 'Choose a lead source.' } });

    const settings = await loadSettings(db);
    let counselorId = ctx.role === 'COUNSELOR' ? ctx.userId : (dto.counselorId ?? null);
    if (!counselorId && settings.roundRobin) counselorId = await pickRoundRobin(db, 'COUNSELOR');
    if (counselorId) await assertAssignable(db, counselorId, 'COUNSELOR');
    const telecallerId = dto.telecallerId ?? null;
    if (telecallerId) await assertAssignable(db, telecallerId, 'TELECALLER');

    const student = await db.student.create({
      data: {
        name: dto.name,
        parentName: dto.parentName ?? null,
        phoneRaw: dto.phone,
        phoneE164,
        altPhoneE164,
        email: dto.email ?? null,
        town: dto.town ?? null,
        district: dto.district ?? null,
        state: dto.state ?? null,
        address: dto.address ?? null,
        createdById: ctx.userId,
      } as Prisma.StudentUncheckedCreateInput,
    });
    const lead = await db.lead.create({
      data: {
        studentId: student.id,
        sourceId: source.id,
        stage: 'NEW',
        isPotential: dto.isPotential ?? false,
        priority: dto.priority ?? 'NORMAL',
        interestCountry: dto.interestCountry ?? null,
        interestCourse: dto.interestCourse ?? null,
      } as Prisma.LeadUncheckedCreateInput,
    });
    await db.leadStatusHistory.create({
      data: {
        leadId: lead.id,
        fromStage: null,
        toStage: 'NEW',
        changedById: ctx.userId,
      } as Prisma.LeadStatusHistoryUncheckedCreateInput,
    });
    if (counselorId) await setAssignment(db, lead.id, 'COUNSELOR', counselorId, ctx.userId);
    if (telecallerId) await setAssignment(db, lead.id, 'TELECALLER', telecallerId, ctx.userId);

    await recordActivity(db, {
      studentId: student.id,
      leadId: lead.id,
      type: 'SYSTEM',
      actorId: ctx.userId,
      summary: `Student added (source: ${source.label})`,
      payload: { sourceId: source.id },
    });
    if (dto.note) {
      await db.note.create({
        data: { leadId: lead.id, authorId: ctx.userId, body: dto.note } as Prisma.NoteUncheckedCreateInput,
      });
      await recordActivity(db, {
        studentId: student.id,
        leadId: lead.id,
        type: 'NOTE',
        actorId: ctx.userId,
        summary: dto.note,
      });
    }
    await audit(db, ctx, 'student.create', 'student', student.id, undefined, {
      student,
      leadId: lead.id,
      counselorId,
      telecallerId,
    });

    const possibleDuplicateEmail = dto.email
      ? (await countStudentsByEmail(db, dto.email, student.id)) > 0
      : false;
    return { studentId: student.id, leadId: lead.id, possibleDuplicateEmail };
  });
}

// ── Detail ───────────────────────────────────────────────────────────────────

export async function getLead(ctx: Ctx, leadId: string) {
  return withTenant(ctx.tenantId, async (db) => {
    const lead = await loadLead(db, ctx, leadId, 'student:read');
    const [assignments, followUps, notes, history, otherLeads] = await leadDetailRelations(
      db,
      lead.id,
      lead.studentId,
    );
    const names = await userNames(db, [
      ...assignments.flatMap((a) => [a.assigneeId, a.assignedById]),
      ...followUps.map((f) => f.assigneeId),
      ...notes.map((n) => n.authorId),
      ...history.map((h) => h.changedById),
    ]);
    const name = (id: string | null | undefined) => (id ? (names.get(id) ?? 'Platform admin') : null);
    const reduced = seesReducedStudentFields(ctx.role);
    const resource = { tenantId: lead.tenantId, assigneeIds: lead.assignments.map((a) => a.assigneeId) };
    const owner = (fn: RoleFunction) => {
      const a = assignments.find((x) => x.isActive && x.roleFunction === fn);
      return a ? { id: a.assigneeId, name: name(a.assigneeId) } : null;
    };
    return {
      id: lead.id,
      stage: lead.stage,
      isPotential: lead.isPotential,
      priority: lead.priority,
      interestCountry: lead.interestCountry,
      interestCourse: lead.interestCourse,
      nextCallAt: lead.nextCallAt,
      lastContactedAt: lead.lastContactedAt,
      lostReason: lead.lostReason,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      source: lead.source,
      student: {
        id: lead.student.id,
        name: lead.student.name,
        parentName: lead.student.parentName,
        phone: lead.student.phoneE164,
        altPhone: lead.student.altPhoneE164,
        email: reduced ? null : lead.student.email,
        town: lead.student.town,
        district: lead.student.district,
        state: lead.student.state,
        address: reduced ? null : lead.student.address,
        createdAt: lead.student.createdAt,
      },
      counselor: owner('COUNSELOR'),
      telecaller: owner('TELECALLER'),
      assignmentHistory: assignments.map((a) => ({
        ...a,
        assigneeName: name(a.assigneeId),
        assignedByName: name(a.assignedById),
      })),
      followUps: followUps.map((f) => ({ ...f, assigneeName: name(f.assigneeId) })),
      notes: notes.map((n) => ({ ...n, authorName: name(n.authorId) })),
      history: history.map((h) => ({ ...h, changedByName: name(h.changedById) })),
      otherLeads: otherLeads.filter((l) => l.id !== lead.id),
      permissions: {
        editStudent: can(ctx, 'student:update', resource),
        editContactOnly: ctx.role === 'TELECALLER',
        changeStage: can(ctx, 'lead:changeStage', resource),
        markPotential: can(ctx, 'lead:markPotential', resource),
        assignCounselor: can(ctx, 'lead:assignCounselor', resource),
        assignTelecaller: can(ctx, 'lead:assignTelecaller', resource),
        scheduleFollowup: can(ctx, 'followup:schedule', resource),
        logDisposition: can(ctx, 'followup:logDisposition', resource),
        addNote: can(ctx, 'note:add', resource),
        delete: can(ctx, 'student:delete', resource),
      },
    };
  });
}
export type LeadDetailDTO = Awaited<ReturnType<typeof getLead>>;

export async function getTimeline(ctx: Ctx, leadId: string, cursorStr: string | undefined, limit = 30) {
  const cursor = decodeKeyset(cursorStr, 'timeline');
  return withTenant(ctx.tenantId, async (db) => {
    const lead = await loadLead(db, ctx, leadId, 'activity:view');
    const rows = await listTimeline(
      db,
      { AND: [{ studentId: lead.studentId }, keysetWhere('createdAt', 'desc', cursor)] },
      limit,
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const names = await userNames(
      db,
      items.map((i) => i.actorId),
    );
    const last = items[items.length - 1];
    return {
      items: items.map((i) => ({
        ...i,
        actorName: i.actorId ? (names.get(i.actorId) ?? 'Platform admin') : 'System',
      })),
      nextCursor: hasMore && last ? encodeKeyset('timeline', last.createdAt, last.id) : null,
    };
  });
}

// ── Updates ──────────────────────────────────────────────────────────────────

/** Stage change: lead row + append-only history + timeline + audit, in the caller's transaction. */
export async function applyStageChange(
  db: TenantDb,
  ctx: Ctx,
  lead: { id: string; studentId: string; stage: LeadStage },
  to: LeadStage,
  note?: string | null,
  reason?: string | null,
): Promise<boolean> {
  if (lead.stage === to) return false;
  await db.lead.updateMany({
    where: { id: lead.id },
    data: {
      stage: to,
      ...(NEGATIVE_STAGES.includes(to) && reason ? { lostReason: reason } : {}),
      ...(lead.stage === 'NEW' ? { lastContactedAt: new Date() } : {}),
    },
  });
  await db.leadStatusHistory.create({
    data: {
      leadId: lead.id,
      fromStage: lead.stage,
      toStage: to,
      changedById: ctx.userId,
      note: note ?? null,
      reason: reason ?? null,
    } as Prisma.LeadStatusHistoryUncheckedCreateInput,
  });
  await recordActivity(db, {
    studentId: lead.studentId,
    leadId: lead.id,
    type: 'STATUS_CHANGE',
    actorId: ctx.userId,
    summary: `Stage changed from ${STAGE_LABEL[lead.stage]} to ${STAGE_LABEL[to]}${note ? ` — ${note}` : ''}`,
    payload: { from: lead.stage, to, note: note ?? null, reason: reason ?? null },
  });
  await audit(
    db,
    ctx,
    'lead.stage_change',
    'lead',
    lead.id,
    { stage: lead.stage },
    { stage: to, note, reason },
  );
  return true;
}

async function applyAssignment(
  db: TenantDb,
  ctx: Ctx,
  lead: { id: string; studentId: string },
  fn: RoleFunction,
  userId: string | null,
) {
  const target = userId ? await assertAssignable(db, userId, fn) : null;
  const { previous, changed } = await setAssignment(db, lead.id, fn, userId, ctx.userId);
  if (!changed) return;
  const label = fn === 'COUNSELOR' ? 'Counselor' : 'Telecaller';
  await recordActivity(db, {
    studentId: lead.studentId,
    leadId: lead.id,
    type: 'ASSIGNMENT',
    actorId: ctx.userId,
    summary: target ? `${label} set to ${target.name}` : `${label} removed`,
    payload: { function: fn, from: previous, to: userId },
  });
  await audit(db, ctx, 'lead.assign', 'lead', lead.id, { [fn]: previous }, { [fn]: userId });
}

export async function updateLead(ctx: Ctx, leadId: string, dto: LeadUpdateDTO) {
  return withTenant(ctx.tenantId, async (db) => {
    const lead = await loadLead(db, ctx, leadId, 'student:read');
    const resource = { tenantId: lead.tenantId, assigneeIds: lead.assignments.map((a) => a.assigneeId) };

    if (dto.stage !== undefined) {
      authorize(ctx, 'lead:changeStage', resource);
      if (
        NEGATIVE_STAGES.includes(dto.stage) &&
        dto.stage !== 'DUPLICATE' &&
        !dto.lostReason &&
        !dto.stageNote
      ) {
        throw invalid('Say why this lead is being closed.', { fields: { lostReason: 'Add a reason.' } });
      }
      await applyStageChange(db, ctx, lead, dto.stage, dto.stageNote, dto.lostReason);
    }
    if (dto.isPotential !== undefined || dto.priority !== undefined) {
      authorize(ctx, 'lead:markPotential', resource);
    }
    if (dto.interestCountry !== undefined || dto.interestCourse !== undefined) {
      authorize(ctx, 'student:update', resource);
    }
    const fields: Prisma.LeadUpdateManyMutationInput = {};
    if (dto.isPotential !== undefined) fields.isPotential = dto.isPotential;
    if (dto.priority !== undefined) fields.priority = dto.priority;
    if (dto.interestCountry !== undefined) fields.interestCountry = dto.interestCountry;
    if (dto.interestCourse !== undefined) fields.interestCourse = dto.interestCourse;
    if (Object.keys(fields).length) {
      await db.lead.updateMany({ where: { id: lead.id }, data: fields });
      await audit(
        db,
        ctx,
        'lead.update',
        'lead',
        lead.id,
        {
          isPotential: lead.isPotential,
          priority: lead.priority,
          interestCountry: lead.interestCountry,
          interestCourse: lead.interestCourse,
        },
        fields,
      );
      if (dto.isPotential !== undefined && dto.isPotential !== lead.isPotential) {
        await recordActivity(db, {
          studentId: lead.studentId,
          leadId: lead.id,
          type: 'SYSTEM',
          actorId: ctx.userId,
          summary: dto.isPotential ? 'Marked as potential lead' : 'Potential flag removed',
        });
      }
      if (dto.priority !== undefined && dto.priority !== lead.priority) {
        await recordActivity(db, {
          studentId: lead.studentId,
          leadId: lead.id,
          type: 'SYSTEM',
          actorId: ctx.userId,
          summary: dto.priority === 'HOT' ? 'Marked HOT' : 'HOT tag removed',
        });
      }
    }
    if (dto.counselorId !== undefined) {
      authorize(ctx, 'lead:assignCounselor', resource);
      await applyAssignment(db, ctx, lead, 'COUNSELOR', dto.counselorId);
    }
    if (dto.telecallerId !== undefined) {
      authorize(ctx, 'lead:assignTelecaller', resource);
      await applyAssignment(db, ctx, lead, 'TELECALLER', dto.telecallerId);
    }
    return { id: lead.id };
  });
}

export async function updateStudent(ctx: Ctx, studentId: string, dto: StudentUpdateDTO) {
  return withTenant(ctx.tenantId, async (db) => {
    const student = await loadStudent(db, ctx, studentId, 'student:update');
    const lead = { id: student.leads[0]?.id ?? null, studentId: student.id, student };
    // Telecallers may correct phone numbers only (RBAC_MATRIX "own (phone/alt only)").
    if (ctx.role === 'TELECALLER') {
      const allowed = new Set(['phone', 'altPhone']);
      const extra = Object.entries(dto).filter(([k, v]) => v !== undefined && !allowed.has(k));
      if (extra.length) throw forbidden('Telecallers can only change phone numbers.');
    }
    const data: Prisma.StudentUpdateManyMutationInput = {};
    if (dto.phone !== undefined) {
      const e164 = toE164(dto.phone);
      if (!e164)
        throw invalid('Enter a valid mobile number.', { fields: { phone: 'Enter a valid mobile number.' } });
      if (e164 !== lead.student.phoneE164) {
        const clash = await findStudentByPhone(db, e164, lead.studentId);
        if (clash)
          throw conflict('Another student already has this number.', {
            fields: { phone: 'Already used by another student.' },
            leadId: clash.leads[0]?.id ?? null,
          });
      }
      data.phoneRaw = dto.phone;
      data.phoneE164 = e164;
    }
    if (dto.altPhone !== undefined) {
      const alt = dto.altPhone ? toE164(dto.altPhone) : null;
      if (dto.altPhone && !alt)
        throw invalid('Enter a valid alternate number.', {
          fields: { altPhone: 'Enter a valid mobile number.' },
        });
      data.altPhoneE164 = alt;
    }
    for (const k of ['name', 'parentName', 'email', 'town', 'district', 'state', 'address'] as const) {
      if (dto[k] !== undefined) (data as Record<string, unknown>)[k] = dto[k];
    }
    await db.student.updateMany({ where: { id: lead.studentId }, data });
    const before = Object.fromEntries(
      Object.keys(data).map((k) => [k, (lead.student as Record<string, unknown>)[k]]),
    );
    await audit(db, ctx, 'student.update', 'student', lead.studentId, before, data);
    await recordActivity(db, {
      studentId: lead.studentId,
      leadId: lead.id,
      type: 'SYSTEM',
      actorId: ctx.userId,
      summary: `Contact details updated (${Object.keys(data)
        .filter((k) => k !== 'phoneRaw')
        .join(', ')})`,
    });
    const possibleDuplicateEmail = dto.email
      ? (await countStudentsByEmail(db, dto.email, lead.studentId)) > 0
      : false;
    return { id: student.id, possibleDuplicateEmail };
  });
}

export async function addNote(ctx: Ctx, leadId: string, body: string) {
  return withTenant(ctx.tenantId, async (db) => {
    const lead = await loadLead(db, ctx, leadId, 'note:add');
    const note = await db.note.create({
      data: { leadId: lead.id, authorId: ctx.userId, body } as Prisma.NoteUncheckedCreateInput,
    });
    await recordActivity(db, {
      studentId: lead.studentId,
      leadId: lead.id,
      type: 'NOTE',
      actorId: ctx.userId,
      summary: body,
    });
    await audit(db, ctx, 'note.create', 'note', note.id, undefined, { leadId: lead.id });
    return { id: note.id, createdAt: note.createdAt };
  });
}

/** Soft delete (admin): the student and all their leads; open follow-ups are closed. */
export async function deleteStudent(ctx: Ctx, studentId: string) {
  return withTenant(ctx.tenantId, async (db) => {
    const student = await loadStudent(db, ctx, studentId, 'student:delete');
    const at = new Date();
    await db.student.updateMany({ where: { id: student.id }, data: { deletedAt: at } });
    await db.lead.updateMany({ where: { studentId: student.id }, data: { deletedAt: at, nextCallAt: null } });
    const leadIds = student.leads.map((l) => l.id);
    await db.followUp.updateMany({
      where: { leadId: { in: leadIds }, completedAt: null },
      data: { completedAt: at, outcomeNote: 'Closed: student deleted' },
    });
    await audit(
      db,
      ctx,
      'student.delete',
      'student',
      student.id,
      { name: student.name, phone: student.phoneE164 },
      { deletedAt: at },
    );
    return { id: student.id };
  });
}

// ── Bulk (admin) ─────────────────────────────────────────────────────────────

export async function bulkAction(ctx: Ctx, dto: BulkActionDTO) {
  authorize(ctx, 'student:bulk');
  return withTenant(
    ctx.tenantId,
    async (db) => {
      const leads = await db.lead.findMany({
        where: { id: { in: dto.ids }, deletedAt: null },
        select: { id: true, studentId: true, stage: true },
      });
      if (leads.length === 0) throw notFound('Leads');
      let changed = 0;
      if (dto.action === 'reassign') {
        if (dto.counselorId === undefined && dto.telecallerId === undefined)
          throw invalid('Choose a counselor or telecaller.');
        if (dto.counselorId) await assertAssignable(db, dto.counselorId, 'COUNSELOR');
        if (dto.telecallerId) await assertAssignable(db, dto.telecallerId, 'TELECALLER');
        for (const lead of leads) {
          if (dto.counselorId !== undefined)
            await applyAssignment(db, ctx, lead, 'COUNSELOR', dto.counselorId);
          if (dto.telecallerId !== undefined)
            await applyAssignment(db, ctx, lead, 'TELECALLER', dto.telecallerId);
          changed++;
        }
      } else {
        const to: LeadStage = dto.action === 'block' ? 'BLOCKED' : dto.stage;
        for (const lead of leads)
          if (
            await applyStageChange(
              db,
              ctx,
              lead,
              to,
              dto.note,
              dto.action === 'block' ? 'Blocked by admin' : null,
            )
          )
            changed++;
      }
      await audit(db, ctx, `lead.bulk_${dto.action}`, 'lead', null, undefined, {
        ids: leads.map((l) => l.id),
        changed,
      });
      return { requested: dto.ids.length, found: leads.length, changed };
    },
    { timeoutMs: 120_000 },
  );
}
