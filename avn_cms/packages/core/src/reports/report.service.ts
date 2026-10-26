import { Prisma, withTenant, type CallDisposition, type LeadStage, type TenantDb } from '@avn-cms/db';

import { userNames } from '../assignments/assignment.repository';
import { can, scopeOf } from '../policy/index';
import { CLOSED_STAGES, POSITIVE_STAGES, type ReportQuery } from '../schemas';
import { cached } from '../shared/cache';
import type { Ctx } from '../shared/context';
import { forbidden } from '../shared/errors';
import { dateRange, dayBounds } from '../shared/time';
import { loadSettings } from '../tenants/settings';

/**
 * Reports and dashboards (PAGES_AND_ROUTES "Reports", DEVELOPMENT_PHASES Phase 4). Every
 * number is computed from the tenant's real rows inside a tenant transaction (RLS applies);
 * nothing is estimated. Counselors and telecallers only ever get their own.
 *
 * At hundreds of thousands of leads these are the heavy reads, so each answer is reused for
 * `REPORT_CACHE_SECONDS` (shared/cache.ts, docs/SCALABILITY.md). Keys name the workspace and the person's
 * scope, so an answer is only ever served to someone entitled to it. What a person just did (their own
 * queue, their own cards) is never behind the cache.
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

/** Reports can take a while on a big workspace; this is well inside the 30 s statement limit per query. */
const HEAVY = { timeoutMs: 60_000 } as const;

/** The key an answer is cached under: workspace, report, whose scope, and the filters asked for. */
function reportKey(ctx: Ctx, name: string, q: ReportQuery, who: Who): string {
  const scope = who.kind === 'self' ? `u:${who.userId}` : `all:${who.assigneeId ?? ''}`;
  const filters = [q.dateFrom ?? '', q.dateTo ?? '', q.sourceId ?? '', (q.state ?? '').toLowerCase()];
  return `rep:${ctx.tenantId}:${name}:${scope}:${JSON.stringify(filters)}`;
}

/**
 * Conversion funnel: how many leads reached at least each positive stage (history + current).
 *
 * `wholeWorkspace` says the filter is only the workspace itself (no dates, source, state or person). Then
 * every lead's history is read anyway, and summarising the history first and joining the leads to that is
 * about 3× faster at a million leads than grouping a lead-by-history join. With a narrower filter the
 * lead-first form reads only the history of the leads asked for.
 */
async function funnelIn(db: TenantDb, where: Prisma.Sql, wholeWorkspace = false) {
  const rows = wholeWorkspace
    ? await db.$queryRaw<{ ord: number | null; count: bigint }[]>`
        WITH furthest AS (
          SELECT lead_id, MAX(array_position(${STAGE_ARRAY}, to_stage)) AS ord
          FROM lead_status_history WHERE tenant_id = app_tenant_id() GROUP BY lead_id
        ), reached AS (
          SELECT GREATEST(COALESCE(f.ord, 1), COALESCE(array_position(${STAGE_ARRAY}, l.stage), 1)) AS ord
          FROM leads l LEFT JOIN furthest f ON f.lead_id = l.id
          WHERE ${where}
        )
        SELECT ord, count(*)::bigint AS count FROM reached GROUP BY ord`
    : await db.$queryRaw<{ ord: number | null; count: bigint }[]>`
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

/** True when the filter leaves every lead of the workspace in. */
function isWholeWorkspace(q: ReportQuery, who: Who, range: { gte?: Date; lt?: Date }): boolean {
  const person = who.kind === 'self' ? who.userId : who.assigneeId;
  return !person && !q.sourceId && !q.state && !range.gte && !range.lt;
}

export async function funnel(ctx: Ctx, q: ReportQuery) {
  const who = whoFor(ctx, q.assigneeId);
  return cached(reportKey(ctx, 'funnel', q, who), () =>
    withTenant(
      ctx.tenantId,
      async (db) => {
        const { range } = await ctxRange(db, q);
        return funnelIn(db, leadFilter(q, who, range), isWholeWorkspace(q, who, range));
      },
      HEAVY,
    ),
  );
}

/** Volume and conversion by source. Ad spend is not recorded, so this is conversion ROI, not cost ROI. */
export async function sources(ctx: Ctx, q: ReportQuery) {
  const who = whoFor(ctx, q.assigneeId);
  return cached(reportKey(ctx, 'sources', q, who), () => sourcesNow(ctx, q, who));
}

async function sourcesNow(ctx: Ctx, q: ReportQuery, who: Who) {
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
  return cached(reportKey(ctx, 'status', q, who), () => stageDistributionNow(ctx, q, who));
}

async function stageDistributionNow(ctx: Ctx, q: ReportQuery, who: Who) {
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
  return cached(reportKey(ctx, 'team', q, who), () => teamNow(ctx, q, who));
}

async function teamNow(ctx: Ctx, q: ReportQuery, who: Who) {
  return withTenant(ctx.tenantId, async (db) => {
    const { range } = await ctxRange(db, q);
    const leadWhere = leadFilter({ ...q, assigneeId: undefined }, { kind: 'tenant' }, range);
    const leadRows = await db.$queryRaw<
      { user_id: string; fn: string; leads: bigint; active: bigint; enrolled: bigint; potential: bigint }[]
    >`
      SELECT a.assignee_id AS user_id, a.role_function::text AS fn,
             count(*)::bigint AS leads,
             count(*) FILTER (WHERE l.stage NOT IN ('ENROLLED','NOT_INTERESTED','INVALID','UNREACHABLE','DUPLICATE','BLOCKED','LOST'))::bigint AS active,
             count(*) FILTER (WHERE l.stage = 'ENROLLED')::bigint AS enrolled,
             count(*) FILTER (WHERE l.is_potential)::bigint AS potential
      -- A lead has one active assignment per role function (lead_assignments_active_key), so each lead is
      -- counted once per person and role: plain counts, no DISTINCT (which sorts a million rows).
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
  return cached(reportKey(ctx, 'followups', q, who), () => followupStatsNow(ctx, q, who));
}

async function followupStatsNow(ctx: Ctx, q: ReportQuery, who: Who) {
  return withTenant(ctx.tenantId, async (db) => {
    const { range } = await ctxRange(db, q);
    const person = who.kind === 'self' ? who.userId : who.assigneeId;
    const personSql = person ? Prisma.sql`AND f.assignee_id = ${person}::uuid` : Prisma.empty;
    const doneParts: Prisma.Sql[] = [Prisma.sql`f.completed_at IS NOT NULL`];
    if (range.gte) doneParts.push(Prisma.sql`f.completed_at >= ${range.gte}`);
    if (range.lt) doneParts.push(Prisma.sql`f.completed_at < ${range.lt}`);
    // Calls of leads that are still live, as the lead list shows them.
    const byDisposition = await db.$queryRaw<{ disposition: CallDisposition; count: bigint }[]>`
      SELECT f.disposition, count(*)::bigint AS count
      FROM follow_ups f JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
      WHERE f.tenant_id = app_tenant_id() AND ${Prisma.join(doneParts, ' AND ')} ${personSql}
      GROUP BY f.disposition`;
    const [openRow] = await db.$queryRaw<{ open: bigint; overdue: bigint; escalated: bigint }[]>`
      SELECT count(*)::bigint AS open,
             count(*) FILTER (WHERE f.scheduled_at < now())::bigint AS overdue,
             count(*) FILTER (WHERE f.escalated_at IS NOT NULL)::bigint AS escalated
      FROM follow_ups f JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
      WHERE f.tenant_id = app_tenant_id() AND f.completed_at IS NULL ${personSql}`;
    const logged = byDisposition.reduce((a, b) => a + n(b.count), 0);
    return {
      logged,
      open: n(openRow?.open),
      overdue: n(openRow?.overdue),
      escalated: n(openRow?.escalated),
      byDisposition: byDisposition
        .map((d) => ({ disposition: d.disposition, count: n(d.count) }))
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

const CLOSED_SQL = Prisma.raw(CLOSED_STAGES.map((s) => `'${s}'`).join(','));
const NO_ANSWER_SQL = Prisma.raw(`'NO_ANSWER','BUSY','SWITCHED_OFF'`);

/**
 * The numbers on the dashboard cards, in two passes over the data (one over leads, one over follow-ups)
 * instead of a dozen separate counts: at a million leads that is the difference between 14 seconds and
 * about a second. A lead counts when it is not deleted (deleting a student deletes their leads with them).
 */
async function dashboardCards(ctx: Ctx, tenantWide: boolean) {
  const userId = ctx.userId;
  return withTenant(
    ctx.tenantId,
    async (db) => {
      const { timezone } = await loadSettings(db);
      const { start, end } = dayBounds(timezone);
      const weekAgo = new Date(Date.now() - 7 * 86_400_000);
      // Finished calls older than a week are not on the dashboard: leaving them out lets the index do it.
      const recent = new Date(Math.min(start.getTime(), weekAgo.getTime()));
      const mineLead = tenantWide
        ? Prisma.empty
        : Prisma.sql`AND EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.is_active AND a.assignee_id = ${userId}::uuid)`;
      const mineFu = tenantWide ? Prisma.empty : Prisma.sql`AND f.assignee_id = ${userId}::uuid`;

      const [leadRow] = await db.$queryRaw<
        { active: bigint; potential: bigint; enrolled: bigint; uncontacted: bigint }[]
      >`
        SELECT count(*) FILTER (WHERE l.stage NOT IN (${CLOSED_SQL}))::bigint AS active,
               count(*) FILTER (WHERE l.is_potential AND l.stage NOT IN (${CLOSED_SQL}))::bigint AS potential,
               count(*) FILTER (WHERE l.stage = 'ENROLLED')::bigint AS enrolled,
               count(*) FILTER (WHERE l.stage = 'NEW' AND l.last_contacted_at IS NULL)::bigint AS uncontacted
        FROM leads l
        WHERE l.tenant_id = app_tenant_id() AND l.deleted_at IS NULL ${mineLead}`;

      const [fuRow] = await db.$queryRaw<
        {
          calls_today: bigint;
          overdue: bigint;
          completed_today: bigint;
          callbacks_due: bigint;
          logged7: bigint;
          no_answer7: bigint;
        }[]
      >`
        SELECT count(*) FILTER (WHERE f.completed_at IS NULL AND f.scheduled_at >= ${start} AND f.scheduled_at < ${end})::bigint AS calls_today,
               count(*) FILTER (WHERE f.completed_at IS NULL AND f.scheduled_at < ${start})::bigint AS overdue,
               count(*) FILTER (WHERE f.completed_at >= ${start} AND f.completed_at < ${end})::bigint AS completed_today,
               count(*) FILTER (WHERE f.completed_at IS NULL AND f.scheduled_at < ${end}
                                  AND EXISTS (SELECT 1 FROM follow_ups c
                                              WHERE c.tenant_id = f.tenant_id AND c.lead_id = f.lead_id
                                                AND c.disposition = 'CALL_BACK_LATER'))::bigint AS callbacks_due,
               count(*) FILTER (WHERE f.completed_at >= ${weekAgo})::bigint AS logged7,
               count(*) FILTER (WHERE f.completed_at >= ${weekAgo} AND f.disposition IN (${NO_ANSWER_SQL}))::bigint AS no_answer7
        FROM follow_ups f JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
        WHERE f.tenant_id = app_tenant_id() ${mineFu}
          AND (f.completed_at IS NULL OR f.completed_at >= ${recent})`;

      const logged7 = n(fuRow?.logged7);
      return {
        activeLeads: n(leadRow?.active),
        potential: n(leadRow?.potential),
        enrolled: n(leadRow?.enrolled),
        newUncontacted: n(leadRow?.uncontacted),
        callsToday: n(fuRow?.calls_today),
        overdue: n(fuRow?.overdue),
        completedToday: n(fuRow?.completed_today),
        callbacksDue: n(fuRow?.callbacks_due),
        noAnswerRate7d: logged7 ? Math.round((n(fuRow?.no_answer7) / logged7) * 1000) / 10 : null,
      };
    },
    HEAVY,
  );
}

/** The 30-day intake trend and the all-time funnel: the two slowest parts of the dashboard. */
async function dashboardInsights(ctx: Ctx, tenantWide: boolean) {
  const who: Who = tenantWide ? { kind: 'tenant' } : { kind: 'self', userId: ctx.userId };
  return withTenant(
    ctx.tenantId,
    async (db) => {
      const { timezone } = await loadSettings(db);
      const trend = await intakeTrend(db, timezone, 30, who);
      const funnelData = await funnelIn(db, leadFilter({}, who, {}), tenantWide);
      return { trend, funnel: funnelData };
    },
    HEAVY,
  );
}

/**
 * Role-aware dashboard bundle (PAGES_AND_ROUTES "Dashboard composition"). Admin: tenant-wide;
 * counselor: own leads; telecaller: own call queue.
 *
 * Reused for a minute (shared/cache.ts): the workspace-wide cards, and the trend and funnel of everyone.
 * A person's own cards, call queue and activity are always fresh, so the call they just logged shows.
 * The result is plain JSON (dates as ISO strings) because it is stored in Redis.
 */
export async function dashboard(ctx: Ctx) {
  const tenantWide = can(ctx, 'report:viewTenant');
  const userId = ctx.userId;

  const cards = tenantWide
    ? await cached(`dash-cards:${ctx.tenantId}`, () => dashboardCards(ctx, true))
    : await dashboardCards(ctx, false);
  const insights =
    ctx.role === 'TELECALLER'
      ? { trend: [], funnel: [] }
      : await cached(`dash-insights:${ctx.tenantId}:${tenantWide ? 'all' : `u:${userId}`}`, () =>
          dashboardInsights(ctx, tenantWide),
        );

  const live = await withTenant(ctx.tenantId, async (db) => {
    const { timezone } = await loadSettings(db);
    const { end } = dayBounds(timezone);
    const mineFu: Prisma.FollowUpWhereInput = tenantWide ? {} : { assigneeId: userId };
    const newWebLeads = tenantWide ? await db.webLead.count({ where: { status: 'NEW' } }) : 0;
    const queue = await db.followUp.findMany({
      where: { lead: { deletedAt: null }, ...mineFu, completedAt: null, scheduledAt: { lt: end } },
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
    return {
      newWebLeads,
      queue: queue.map((q) => ({
        ...q,
        scheduledAt: q.scheduledAt.toISOString(),
        assigneeName: names.get(q.assigneeId) ?? null,
      })),
      activity: activity.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
        actorName: a.actorId ? (names.get(a.actorId) ?? 'Platform admin') : 'System',
      })),
    };
  });

  return {
    role: ctx.role,
    tenantWide,
    cards: { ...cards, newWebLeads: live.newWebLeads },
    queue: live.queue,
    activity: live.activity,
    trend: insights.trend,
    funnel: insights.funnel,
  };
}
export type DashboardDTO = Awaited<ReturnType<typeof dashboard>>;
