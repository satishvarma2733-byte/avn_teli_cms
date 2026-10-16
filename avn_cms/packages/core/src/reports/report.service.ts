import { Prisma, withTenant, type CallDisposition, type LeadStage, type TenantDb } from '@avn-cms/db';

import { userNames } from '../assignments/assignment.repository';
import { can, scopeOf } from '../policy/index';
import { CLOSED_STAGES, POSITIVE_STAGES, type ReportQuery } from '../schemas';
import type { Ctx } from '../shared/context';
import { forbidden } from '../shared/errors';
import { dateRange, dayBounds } from '../shared/time';
import { loadSettings } from '../tenants/settings';

/**
 * Reports and dashboards (PAGES_AND_ROUTES "Reports", DEVELOPMENT_PHASES Phase 4). Every
 * number is computed from the tenant's real rows inside a tenant transaction (RLS applies);
 * nothing is estimated or cached here. Counselors and telecallers only ever get their own.
 */

type Who = { kind: 'tenant'; assigneeId?: string | undefined } | { kind: 'self'; userId: string };

/** Admins see the tenant (optionally one person); counselors/telecallers only themselves. */
function whoFor(ctx: Ctx, assigneeId?: string): Who {
  if (can(ctx, 'report:viewTenant')) return { kind: 'tenant', assigneeId };
  if (scopeOf(ctx.role, 'report:viewOwn') === 'self') return { kind: 'self', userId: ctx.userId };
  throw forbidden();
}

/** SQL WHERE fragment over `leads l` for the filters + who. */
function leadFilter(q: ReportQuery, who: Who, range: { gte?: Date; lt?: Date }): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`l.tenant_id = app_tenant_id()`, Prisma.sql`l.deleted_at IS NULL`];
  if (range.gte) parts.push(Prisma.sql`l.created_at >= ${range.gte}`);
  if (range.lt) parts.push(Prisma.sql`l.created_at < ${range.lt}`);
  if (q.sourceId) parts.push(Prisma.sql`l.source_id = ${q.sourceId}::uuid`);
  if (q.state)
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM students s WHERE s.id = l.student_id AND lower(s.state) = lower(${q.state}))`,
    );
  const person = who.kind === 'self' ? who.userId : who.assigneeId;
  if (person) {
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.is_active AND a.assignee_id = ${person}::uuid)`,
    );
  }
  return Prisma.join(parts, ' AND ');
}

const STAGE_ARRAY = Prisma.raw(`ARRAY[${POSITIVE_STAGES.map((s) => `'${s}'`).join(',')}]::lead_stage[]`);

async function ctxRange(db: TenantDb, q: ReportQuery) {
  const { timezone } = await loadSettings(db);
  return { timezone, range: dateRange(timezone, q.dateFrom, q.dateTo) };
}

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** Conversion funnel: how many leads reached at least each positive stage (history + current). */
async function funnelIn(db: TenantDb, where: Prisma.Sql) {
  const rows = await db.$queryRaw<{ ord: number | null; count: bigint }[]>`
    WITH reached AS (
      SELECT l.id,
             GREATEST(
               COALESCE(MAX(array_position(${STAGE_ARRAY}, h.to_stage)), 1),
               COALESCE(array_position(${STAGE_ARRAY}, l.stage), 1)
             ) AS ord
      FROM leads l
      LEFT JOIN lead_status_history h ON h.lead_id = l.id
      WHERE ${where}
      GROUP BY l.id, l.stage
    )
    SELECT ord, count(*)::bigint AS count FROM reached GROUP BY ord`;
  const byOrd = new Map(rows.map((r) => [r.ord ?? 1, n(r.count)]));
  const total = [...byOrd.values()].reduce((a, b) => a + b, 0);
  // "Reached at least stage i" = sum over ord >= i.
  return POSITIVE_STAGES.map((stage, i) => {
    let count = 0;
    for (const [ord, c] of byOrd) if (ord >= i + 1) count += c;
    return { stage, count, pctOfTotal: total ? Math.round((count / total) * 1000) / 10 : 0 };
  });
}

export async function funnel(ctx: Ctx, q: ReportQuery) {
  const who = whoFor(ctx, q.assigneeId);
  return withTenant(ctx.tenantId, async (db) => {
    const { range } = await ctxRange(db, q);
    return funnelIn(db, leadFilter(q, who, range));
  });
}

/** Volume and conversion by source. Ad spend is not recorded, so this is conversion ROI, not cost ROI. */
export async function sources(ctx: Ctx, q: ReportQuery) {
  const who = whoFor(ctx, q.assigneeId);
  return withTenant(ctx.tenantId, async (db) => {
    const { range } = await ctxRange(db, q);
    const where = leadFilter(q, who, range);
    const rows = await db.$queryRaw<
      { id: string; label: string; leads: bigint; contacted: bigint; enrolled: bigint; lost: bigint }[]
    >`
      SELECT ls.id, ls.label,
             count(l.id)::bigint AS leads,
             count(l.id) FILTER (WHERE l.last_contacted_at IS NOT NULL OR l.stage <> 'NEW')::bigint AS contacted,
             count(l.id) FILTER (WHERE l.stage = 'ENROLLED')::bigint AS enrolled,
             count(l.id) FILTER (WHERE l.stage IN ('NOT_INTERESTED','INVALID','UNREACHABLE','DUPLICATE','BLOCKED','LOST'))::bigint AS lost
      FROM leads l JOIN lead_sources ls ON ls.id = l.source_id
      WHERE ${where}
      GROUP BY ls.id, ls.label
      ORDER BY leads DESC`;
    return rows.map((r) => ({
      sourceId: r.id,
      label: r.label,
      leads: n(r.leads),
      contacted: n(r.contacted),
      enrolled: n(r.enrolled),
      lost: n(r.lost),
      conversionPct: n(r.leads) ? Math.round((n(r.enrolled) / n(r.leads)) * 1000) / 10 : 0,
    }));
  });
}

/** Current stage distribution. */
export async function stageDistribution(ctx: Ctx, q: ReportQuery) {
  const who = whoFor(ctx, q.assigneeId);
  return withTenant(ctx.tenantId, async (db) => {
    const { range } = await ctxRange(db, q);
    const rows = await db.$queryRaw<{ stage: LeadStage; count: bigint }[]>`
      SELECT l.stage, count(*)::bigint AS count FROM leads l WHERE ${leadFilter(q, who, range)} GROUP BY l.stage`;
    const map = new Map(rows.map((r) => [r.stage, n(r.count)]));
    return [...POSITIVE_STAGES, 'LONG_TERM', ...CLOSED_STAGES.filter((s) => s !== 'ENROLLED')].map(
      (stage) => ({ stage: stage as LeadStage, count: map.get(stage as LeadStage) ?? 0 }),
    );
  });
}

/** Counselor and telecaller performance, with conversion rate (the gap the review called out). */
export async function team(ctx: Ctx, q: ReportQuery) {
  const who = whoFor(ctx, q.assigneeId);
  return withTenant(ctx.tenantId, async (db) => {
    const { range } = await ctxRange(db, q);
    const leadWhere = leadFilter({ ...q, assigneeId: undefined }, { kind: 'tenant' }, range);
    const leadRows = await db.$queryRaw<
      { user_id: string; fn: string; leads: bigint; active: bigint; enrolled: bigint; potential: bigint }[]
    >`
      SELECT a.assignee_id AS user_id, a.role_function::text AS fn,
             count(DISTINCT l.id)::bigint AS leads,
             count(DISTINCT l.id) FILTER (WHERE l.stage NOT IN ('ENROLLED','NOT_INTERESTED','INVALID','UNREACHABLE','DUPLICATE','BLOCKED','LOST'))::bigint AS active,
             count(DISTINCT l.id) FILTER (WHERE l.stage = 'ENROLLED')::bigint AS enrolled,
             count(DISTINCT l.id) FILTER (WHERE l.is_potential)::bigint AS potential
      FROM lead_assignments a JOIN leads l ON l.id = a.lead_id
      WHERE a.is_active AND ${leadWhere}
      GROUP BY a.assignee_id, a.role_function`;

    const fuParts: Prisma.Sql[] = [Prisma.sql`f.tenant_id = app_tenant_id()`];
    if (range.gte) fuParts.push(Prisma.sql`f.completed_at >= ${range.gte}`);
    if (range.lt) fuParts.push(Prisma.sql`f.completed_at < ${range.lt}`);
    const callRows = await db.$queryRaw<
      { user_id: string; calls: bigint; connected: bigint; no_answer: bigint }[]
    >`
      SELECT f.assignee_id AS user_id,
             count(*)::bigint AS calls,
             count(*) FILTER (WHERE f.disposition IN ('COMPLETED','INTERESTED','NOT_INTERESTED','CALL_BACK_LATER','AWAITING_FEEDBACK'))::bigint AS connected,
             count(*) FILTER (WHERE f.disposition IN ('NO_ANSWER','BUSY','SWITCHED_OFF'))::bigint AS no_answer
      FROM follow_ups f
      WHERE f.completed_at IS NOT NULL AND ${Prisma.join(fuParts, ' AND ')}
      GROUP BY f.assignee_id`;
    const overdueRows = await db.$queryRaw<{ user_id: string; overdue: bigint }[]>`
      SELECT f.assignee_id AS user_id, count(*)::bigint AS overdue
      FROM follow_ups f JOIN leads l ON l.id = f.lead_id
      WHERE f.tenant_id = app_tenant_id() AND f.completed_at IS NULL AND f.scheduled_at < now() AND l.deleted_at IS NULL
      GROUP BY f.assignee_id`;

    const users = await db.user.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        roleCode: { in: ['TENANT_ADMIN', 'COUNSELOR', 'TELECALLER'] },
      },
      select: { id: true, name: true, roleCode: true },
    });
    const rows = users
      .filter((u) => (who.kind === 'self' ? u.id === who.userId : !who.assigneeId || u.id === who.assigneeId))
      .map((u) => {
        const asCounselor = leadRows.find((r) => r.user_id === u.id && r.fn === 'COUNSELOR');
        const asTelecaller = leadRows.find((r) => r.user_id === u.id && r.fn === 'TELECALLER');
        const lr = u.roleCode === 'TELECALLER' ? asTelecaller : asCounselor;
        const calls = callRows.find((r) => r.user_id === u.id);
        const leads = n(lr?.leads);
        const callCount = n(calls?.calls);
        return {
          userId: u.id,
          name: u.name,
          role: u.roleCode,
          leads,
          active: n(lr?.active),
          potential: n(lr?.potential),
          enrolled: n(lr?.enrolled),
          conversionPct: leads ? Math.round((n(lr?.enrolled) / leads) * 1000) / 10 : 0,
          calls: callCount,
          connectedPct: callCount ? Math.round((n(calls?.connected) / callCount) * 1000) / 10 : 0,
          noAnswerPct: callCount ? Math.round((n(calls?.no_answer) / callCount) * 1000) / 10 : 0,
          overdue: n(overdueRows.find((r) => r.user_id === u.id)?.overdue),
        };
      })
      .filter((r) => r.leads > 0 || r.calls > 0 || r.overdue > 0 || who.kind === 'self')
      .sort((a, b) => b.enrolled - a.enrolled || b.conversionPct - a.conversionPct || b.calls - a.calls);
    return rows;
  });
}

/** Follow-up performance: logged calls by outcome, open and overdue counts. */
export async function followupStats(ctx: Ctx, q: ReportQuery) {
  const who = whoFor(ctx, q.assigneeId);
  return withTenant(ctx.tenantId, async (db) => {
    const { range } = await ctxRange(db, q);
    const person = who.kind === 'self' ? who.userId : who.assigneeId;
    const where: Prisma.FollowUpWhereInput = {
      lead: { deletedAt: null },
      ...(person ? { assigneeId: person } : {}),
    };
    const completedRange = {
      ...(range.gte ? { gte: range.gte } : {}),
      ...(range.lt ? { lt: range.lt } : {}),
    };
    const byDisposition = await db.followUp.groupBy({
      by: ['disposition'],
      where: { ...where, completedAt: Object.keys(completedRange).length ? completedRange : { not: null } },
      _count: { _all: true },
    });
    const open = await db.followUp.count({ where: { ...where, completedAt: null } });
    const overdue = await db.followUp.count({
      where: { ...where, completedAt: null, scheduledAt: { lt: new Date() } },
    });
    const escalated = await db.followUp.count({
      where: { ...where, completedAt: null, escalatedAt: { not: null } },
    });
    const logged = byDisposition.reduce((a, b) => a + b._count._all, 0);
    return {
      logged,
      open,
      overdue,
      escalated,
      byDisposition: byDisposition
        .map((d) => ({ disposition: d.disposition as CallDisposition, count: d._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  });
}

/** Leads created per day (tenant time zone), last `days` days. */
async function intakeTrend(db: TenantDb, timezone: string, days: number, who: Who) {
  const person = who.kind === 'self' ? who.userId : who.assigneeId;
  const since = new Date(dayBounds(timezone).start.getTime() - (days - 1) * 86_400_000);
  const personSql = person
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.is_active AND a.assignee_id = ${person}::uuid)`
    : Prisma.empty;
  const rows = await db.$queryRaw<{ day: string; count: bigint }[]>`
    SELECT to_char((l.created_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day, count(*)::bigint AS count
    FROM leads l
    WHERE l.tenant_id = app_tenant_id() AND l.deleted_at IS NULL AND l.created_at >= ${since} ${personSql}
    GROUP BY 1 ORDER BY 1`;
  const map = new Map(rows.map((r) => [r.day, n(r.count)]));
  const out: { day: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86_400_000 + 12 * 3_600_000);
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(d);
    out.push({ day: key, count: map.get(key) ?? 0 });
  }
  return out;
}

/**
 * Role-aware dashboard bundle (PAGES_AND_ROUTES "Dashboard composition"). Admin: tenant-wide;
 * counselor: own leads; telecaller: own call queue.
 */
export async function dashboard(ctx: Ctx) {
  const tenantWide = can(ctx, 'report:viewTenant');
  const userId = ctx.userId;
  return withTenant(ctx.tenantId, async (db) => {
    const { timezone } = await loadSettings(db);
    const { start, end } = dayBounds(timezone);
    const now = new Date();
    const mineLead: Prisma.LeadWhereInput = tenantWide
      ? {}
      : { assignments: { some: { assigneeId: userId, isActive: true } } };
    const liveLead: Prisma.LeadWhereInput = { deletedAt: null, student: { deletedAt: null } };
    const mineFu: Prisma.FollowUpWhereInput = tenantWide ? {} : { assigneeId: userId };
    const liveFu: Prisma.FollowUpWhereInput = { lead: { deletedAt: null } };

    const activeLeads = await db.lead.count({
      where: { ...liveLead, ...mineLead, stage: { notIn: CLOSED_STAGES } },
    });
    const potential = await db.lead.count({
      where: { ...liveLead, ...mineLead, isPotential: true, stage: { notIn: CLOSED_STAGES } },
    });
    const enrolled = await db.lead.count({ where: { ...liveLead, ...mineLead, stage: 'ENROLLED' } });
    const callsToday = await db.followUp.count({
      where: { ...liveFu, ...mineFu, completedAt: null, scheduledAt: { gte: start, lt: end } },
    });
    const overdue = await db.followUp.count({
      where: { ...liveFu, ...mineFu, completedAt: null, scheduledAt: { lt: start } },
    });
    const completedToday = await db.followUp.count({
      where: { ...liveFu, ...mineFu, completedAt: { gte: start, lt: end } },
    });
    const callbacksDue = await db.followUp.count({
      where: {
        ...liveFu,
        ...mineFu,
        completedAt: null,
        scheduledAt: { lt: end },
        lead: { deletedAt: null, followUps: { some: { disposition: 'CALL_BACK_LATER' } } },
      },
    });
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const logged7 = await db.followUp.count({
      where: { ...liveFu, ...mineFu, completedAt: { gte: weekAgo } },
    });
    const noAnswer7 = await db.followUp.count({
      where: {
        ...liveFu,
        ...mineFu,
        completedAt: { gte: weekAgo },
        disposition: { in: ['NO_ANSWER', 'BUSY', 'SWITCHED_OFF'] },
      },
    });
    const newUncontacted = await db.lead.count({
      where: { ...liveLead, ...mineLead, stage: 'NEW', lastContactedAt: null },
    });
    const newWebLeads = tenantWide ? await db.webLead.count({ where: { status: 'NEW' } }) : 0;

    const queue = await db.followUp.findMany({
      where: { ...liveFu, ...mineFu, completedAt: null, scheduledAt: { lt: end } },
      orderBy: { scheduledAt: 'asc' },
      take: 8,
      select: {
        id: true,
        scheduledAt: true,
        priority: true,
        assigneeId: true,
        lead: { select: { id: true, stage: true, student: { select: { name: true, phoneE164: true } } } },
      },
    });
    const activity = await db.activity.findMany({
      where: tenantWide ? {} : { lead: { assignments: { some: { assigneeId: userId, isActive: true } } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        type: true,
        summary: true,
        actorId: true,
        createdAt: true,
        leadId: true,
        student: { select: { name: true } },
      },
    });
    const names = await userNames(db, [...queue.map((q) => q.assigneeId), ...activity.map((a) => a.actorId)]);
    const who: Who = tenantWide ? { kind: 'tenant' } : { kind: 'self', userId };
    const trend = ctx.role === 'TELECALLER' ? [] : await intakeTrend(db, timezone, 30, who);
    const funnelData = ctx.role === 'TELECALLER' ? [] : await funnelIn(db, leadFilter({}, who, {}));

    return {
      role: ctx.role,
      tenantWide,
      cards: {
        activeLeads,
        callsToday,
        potential,
        enrolled,
        overdue,
        completedToday,
        callbacksDue,
        noAnswerRate7d: logged7 ? Math.round((noAnswer7 / logged7) * 1000) / 10 : null,
        newUncontacted,
        newWebLeads,
      },
      queue: queue.map((q) => ({ ...q, assigneeName: names.get(q.assigneeId) ?? null })),
      activity: activity.map((a) => ({
        ...a,
        actorName: a.actorId ? (names.get(a.actorId) ?? 'Platform admin') : 'System',
      })),
      trend,
      funnel: funnelData,
    };
  });
}
export type DashboardDTO = Awaited<ReturnType<typeof dashboard>>;
