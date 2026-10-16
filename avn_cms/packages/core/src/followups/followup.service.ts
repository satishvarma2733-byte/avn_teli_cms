import { withTenant, type CallDisposition, type Prisma, type TenantDb } from '@avn-cms/db';
import type { z } from 'zod';

import { recordActivity } from '../activities/activity.repository';
import { userNames } from '../assignments/assignment.repository';
import { applyStageChange, loadLead } from '../leads/lead.service';
import { can, listScope } from '../policy/index';
import {
  DISPOSITION_LABEL,
  type FollowupBucket,
  type followupCreateSchema,
  type followupListQuerySchema,
  type followupUpdateSchema,
} from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, forbidden, invalid, notFound } from '../shared/errors';
import { decodeKeyset, encodeKeyset, keysetWhere } from '../shared/pagination';
import { dayBounds } from '../shared/time';
import { loadSettings } from '../tenants/settings';

type ListQuery = z.output<typeof followupListQuerySchema>;
type CreateDTO = z.output<typeof followupCreateSchema>;
type UpdateDTO = z.output<typeof followupUpdateSchema>;

/** Dispositions that mean we actually spoke to someone (updates "last contacted"). */
const CONNECTED: CallDisposition[] = [
  'COMPLETED',
  'INTERESTED',
  'NOT_INTERESTED',
  'CALL_BACK_LATER',
  'AWAITING_FEEDBACK',
];

/** Keeps leads.next_call_at equal to the earliest open follow-up (drives queues and the workspace). */
export async function recomputeNextCall(db: TenantDb, leadId: string): Promise<void> {
  const next = await db.followUp.findFirst({
    where: { leadId, completedAt: null },
    orderBy: { scheduledAt: 'asc' },
    select: { scheduledAt: true },
  });
  await db.lead.updateMany({ where: { id: leadId }, data: { nextCallAt: next?.scheduledAt ?? null } });
}

function bucketWhere(bucket: FollowupBucket, start: Date, end: Date): Prisma.FollowUpWhereInput {
  switch (bucket) {
    case 'today':
      return { completedAt: null, scheduledAt: { gte: start, lt: end } };
    case 'upcoming':
      return { completedAt: null, scheduledAt: { gte: end } };
    case 'overdue':
      return { completedAt: null, scheduledAt: { lt: start } };
    case 'pending':
      return { completedAt: null };
    case 'closed':
      return { completedAt: { not: null } };
  }
}

const select = {
  id: true,
  scheduledAt: true,
  disposition: true,
  priority: true,
  outcomeNote: true,
  completedAt: true,
  isOverdue: true,
  escalatedAt: true,
  assigneeId: true,
  createdAt: true,
  lead: {
    select: {
      id: true,
      stage: true,
      isPotential: true,
      priority: true,
      interestCountry: true,
      student: { select: { name: true, phoneE164: true, town: true } },
    },
  },
} satisfies Prisma.FollowUpSelect;

/** The call queue (Today / Upcoming / Pending / Overdue / Closed), own-only for callers. */
export async function listQueue(ctx: Ctx, q: ListQuery) {
  const scope = listScope(ctx, 'followup:view');
  if (!scope) throw forbidden();
  const closed = q.bucket === 'closed';
  const sortField = closed ? 'completedAt' : 'scheduledAt';
  const dir = closed ? 'desc' : 'asc';
  const cursor = decodeKeyset(q.cursor, `fu-${q.bucket}`);

  return withTenant(ctx.tenantId, async (db) => {
    const { timezone } = await loadSettings(db);
    const { start, end } = dayBounds(timezone);
    const and: Prisma.FollowUpWhereInput[] = [
      bucketWhere(q.bucket, start, end),
      { lead: { deletedAt: null } },
    ];
    if (scope === 'own') and.push({ assigneeId: ctx.userId });
    else if (q.assigneeId) and.push({ assigneeId: q.assigneeId });

    const rows = await db.followUp.findMany({
      where: { AND: [...and, keysetWhere(sortField, dir, cursor)] },
      orderBy: [{ [sortField]: dir }, { id: dir }],
      take: q.limit + 1,
      select,
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const names = await userNames(
      db,
      items.map((i) => i.assigneeId),
    );
    const last = items[items.length - 1];
    const lastValue = last ? (closed ? last.completedAt : last.scheduledAt) : null;
    return {
      items: items.map((i) => ({ ...i, assigneeName: names.get(i.assigneeId) ?? null })),
      nextCursor: hasMore && last && lastValue ? encodeKeyset(`fu-${q.bucket}`, lastValue, last.id) : null,
    };
  });
}

/** Tab badges: open calls per bucket for the caller's scope. */
export async function queueCounts(ctx: Ctx, assigneeId?: string) {
  const scope = listScope(ctx, 'followup:view');
  if (!scope) throw forbidden();
  return withTenant(ctx.tenantId, async (db) => {
    const { timezone } = await loadSettings(db);
    const { start, end } = dayBounds(timezone);
    const who: Prisma.FollowUpWhereInput =
      scope === 'own' ? { assigneeId: ctx.userId } : assigneeId ? { assigneeId } : {};
    const base: Prisma.FollowUpWhereInput = { ...who, lead: { deletedAt: null } };
    // Sequential: queries share the transaction's single connection.
    const counts = { today: 0, upcoming: 0, overdue: 0, pending: 0 };
    for (const b of ['today', 'upcoming', 'overdue', 'pending'] as const) {
      counts[b] = await db.followUp.count({ where: { AND: [base, bucketWhere(b, start, end)] } });
    }
    return counts;
  });
}

/** Who may be given a call: an active tenant user who can work leads. */
async function assertCaller(db: TenantDb, userId: string) {
  const user = await db.user.findFirst({
    where: {
      id: userId,
      status: 'ACTIVE',
      deletedAt: null,
      roleCode: { in: ['TENANT_ADMIN', 'COUNSELOR', 'TELECALLER'] },
    },
    select: { id: true, name: true },
  });
  if (!user)
    throw invalid('Choose an active team member.', { fields: { assigneeId: 'Not an active team member.' } });
  return user;
}

export async function schedule(ctx: Ctx, dto: CreateDTO) {
  const at = new Date(dto.scheduledAt);
  if (at.getTime() < Date.now() - 5 * 60_000)
    throw invalid('Choose a time in the future.', {
      fields: { scheduledAt: 'Choose a time in the future.' },
    });
  return withTenant(ctx.tenantId, async (db) => {
    const lead = await loadLead(db, ctx, dto.leadId, 'followup:schedule');
    const assigneeIds = lead.assignments.map((a) => a.assigneeId);
    let assigneeId = dto.assigneeId ?? null;
    if (!assigneeId) {
      assigneeId =
        lead.assignments.find((a) => a.roleFunction === 'TELECALLER')?.assigneeId ??
        lead.assignments.find((a) => a.roleFunction === 'COUNSELOR')?.assigneeId ??
        ctx.userId;
    }
    // Callers can book calls for themselves or the lead's own team, not for anyone else.
    if (
      ctx.role !== 'TENANT_ADMIN' &&
      ctx.role !== 'SUPER_ADMIN' &&
      assigneeId !== ctx.userId &&
      !assigneeIds.includes(assigneeId)
    ) {
      throw forbidden('You can only schedule calls for yourself or this lead’s team.');
    }
    const caller = await assertCaller(db, assigneeId);
    const fu = await db.followUp.create({
      data: {
        leadId: lead.id,
        scheduledAt: at,
        assigneeId: caller.id,
        priority: dto.priority ?? lead.priority,
        outcomeNote: null,
        createdById: ctx.userId,
      } as Prisma.FollowUpUncheckedCreateInput,
    });
    await recomputeNextCall(db, lead.id);
    await recordActivity(db, {
      studentId: lead.studentId,
      leadId: lead.id,
      type: 'SYSTEM',
      actorId: ctx.userId,
      summary: `Call scheduled for ${at.toISOString()} with ${caller.name}${dto.note ? ` — ${dto.note}` : ''}`,
      payload: {
        followUpId: fu.id,
        scheduledAt: at.toISOString(),
        assigneeId: caller.id,
        note: dto.note ?? null,
      },
    });
    await audit(db, ctx, 'followup.schedule', 'follow_up', fu.id, undefined, {
      leadId: lead.id,
      scheduledAt: at,
      assigneeId: caller.id,
    });
    return { id: fu.id };
  });
}

export async function update(ctx: Ctx, followUpId: string, dto: UpdateDTO) {
  return withTenant(ctx.tenantId, async (db) => {
    const fu = await db.followUp.findFirst({ where: { id: followUpId } });
    if (!fu) throw notFound('Follow-up');
    const lead = await loadLead(db, ctx, fu.leadId, 'student:read');
    const resource = {
      tenantId: lead.tenantId,
      assigneeIds: [...lead.assignments.map((a) => a.assigneeId), fu.assigneeId],
    };
    const result = { stageApplied: false, nextFollowUpId: null as string | null };

    if (dto.disposition) {
      if (!can(ctx, 'followup:logDisposition', resource)) throw forbidden();
      if (fu.completedAt) throw conflict('This call has already been logged.');
      const now = new Date();
      await db.followUp.updateMany({
        where: { id: fu.id, completedAt: null },
        data: {
          disposition: dto.disposition,
          outcomeNote: dto.outcomeNote ?? null,
          completedAt: now,
          isOverdue: false,
        },
      });
      if (CONNECTED.includes(dto.disposition))
        await db.lead.updateMany({ where: { id: lead.id }, data: { lastContactedAt: now } });
      await recordActivity(db, {
        studentId: lead.studentId,
        leadId: lead.id,
        type: 'CALL',
        actorId: ctx.userId,
        direction: 'OUT',
        summary: `Call: ${DISPOSITION_LABEL[dto.disposition]}${dto.outcomeNote ? ` — ${dto.outcomeNote}` : ''}`,
        payload: { followUpId: fu.id, disposition: dto.disposition },
      });
      await audit(
        db,
        ctx,
        'followup.log',
        'follow_up',
        fu.id,
        { disposition: fu.disposition },
        { disposition: dto.disposition, outcomeNote: dto.outcomeNote },
      );

      // A disposition may suggest a stage; it is applied only when asked and allowed.
      if (dto.applyStage && can(ctx, 'lead:changeStage', resource)) {
        result.stageApplied = await applyStageChange(
          db,
          ctx,
          lead,
          dto.applyStage,
          `After call: ${DISPOSITION_LABEL[dto.disposition]}`,
        );
      }
      if (dto.nextCallAt) {
        const nextAt = new Date(dto.nextCallAt);
        if (nextAt.getTime() < Date.now())
          throw invalid('The next call must be in the future.', {
            fields: { nextCallAt: 'Choose a future time.' },
          });
        const next = await db.followUp.create({
          data: {
            leadId: lead.id,
            scheduledAt: nextAt,
            assigneeId: fu.assigneeId,
            priority: dto.priority ?? fu.priority,
            createdById: ctx.userId,
          } as Prisma.FollowUpUncheckedCreateInput,
        });
        result.nextFollowUpId = next.id;
        await recordActivity(db, {
          studentId: lead.studentId,
          leadId: lead.id,
          type: 'SYSTEM',
          actorId: ctx.userId,
          summary: `Next call booked for ${nextAt.toISOString()}`,
          payload: { followUpId: next.id, scheduledAt: nextAt.toISOString() },
        });
      }
    } else if (dto.scheduledAt) {
      if (!can(ctx, 'followup:schedule', resource)) throw forbidden();
      if (fu.completedAt) throw conflict('A logged call can’t be rescheduled. Schedule a new one.');
      const at = new Date(dto.scheduledAt);
      await db.followUp.updateMany({
        where: { id: fu.id },
        data: { scheduledAt: at, isOverdue: false, ...(dto.priority ? { priority: dto.priority } : {}) },
      });
      await recordActivity(db, {
        studentId: lead.studentId,
        leadId: lead.id,
        type: 'SYSTEM',
        actorId: ctx.userId,
        summary: `Call rescheduled to ${at.toISOString()}`,
        payload: { followUpId: fu.id, from: fu.scheduledAt.toISOString(), to: at.toISOString() },
      });
      await audit(
        db,
        ctx,
        'followup.reschedule',
        'follow_up',
        fu.id,
        { scheduledAt: fu.scheduledAt },
        { scheduledAt: at },
      );
    } else if (dto.priority) {
      if (!can(ctx, 'followup:schedule', resource)) throw forbidden();
      await db.followUp.updateMany({ where: { id: fu.id }, data: { priority: dto.priority } });
    }
    await recomputeNextCall(db, lead.id);
    return result;
  });
}

/**
 * Worker sweep for one tenant: flags open calls past their slot as overdue and escalates
 * those overdue longer than `escalateAfterHours` to the tenant admins (in-app notification).
 */
export async function sweepOverdue(db: TenantDb, now = new Date(), escalateAfterHours = 24) {
  const flagged = await db.followUp.updateMany({
    where: { completedAt: null, isOverdue: false, scheduledAt: { lt: now } },
    data: { isOverdue: true },
  });
  const cutoff = new Date(now.getTime() - escalateAfterHours * 3_600_000);
  const toEscalate = await db.followUp.findMany({
    where: { completedAt: null, escalatedAt: null, scheduledAt: { lt: cutoff }, lead: { deletedAt: null } },
    select: {
      id: true,
      assigneeId: true,
      leadId: true,
      lead: { select: { studentId: true, student: { select: { name: true } } } },
    },
    take: 500,
  });
  if (toEscalate.length === 0) return { flagged: flagged.count, escalated: 0 };
  const admins = await db.user.findMany({
    where: { roleCode: 'TENANT_ADMIN', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  const escalateTo = admins[0]?.id ?? null;
  for (const fu of toEscalate) {
    await db.followUp.updateMany({
      where: { id: fu.id, escalatedAt: null },
      data: { escalatedAt: now, escalatedTo: escalateTo },
    });
    const recipients = [...new Set([fu.assigneeId, ...admins.map((a) => a.id)])];
    await db.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        type: 'followup.escalated',
        title: `Overdue call: ${fu.lead.student.name}`,
        body: `A follow-up has been overdue for more than ${escalateAfterHours} hours.`,
        entityType: 'lead',
        entityId: fu.leadId,
      })) as Prisma.NotificationCreateManyInput[],
    });
    await recordActivity(db, {
      studentId: fu.lead.studentId,
      leadId: fu.leadId,
      type: 'SYSTEM',
      summary: `Overdue call escalated${escalateTo ? ' to the admin' : ''}`,
      payload: { followUpId: fu.id },
    });
  }
  return { flagged: flagged.count, escalated: toEscalate.length };
}
