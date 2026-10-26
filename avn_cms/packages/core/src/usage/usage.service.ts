import { withTenant, type TenantDb } from '@avn-cms/db';

import { authorize } from '../policy/index';
import type { Ctx } from '../shared/context';
import { conflict } from '../shared/errors';

/**
 * Plan limits and usage. A plan (Starter, Professional, Ultra, Enterprise) gives a workspace room for
 * so many users, leads and stored files; the workspace's real counts are measured from its own rows,
 * never estimated. A workspace without a plan, or a limit left out of the plan, is unlimited.
 *
 * Billing itself (prices, invoices, payment) is out of scope: this module only measures and limits,
 * and writes a monthly snapshot (`usage_counters`) that a billing system can read.
 */

export interface PlanLimits {
  users: number | null;
  leads: number | null;
  storageBytes: number | null;
}

/** `plans.limits` is `{ max_users, max_leads, storage_mb }`; a missing or null entry means "no limit". */
export function parsePlanLimits(raw: unknown): PlanLimits {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const mb = num(o['storage_mb']);
  return {
    users: num(o['max_users']),
    leads: num(o['max_leads']),
    storageBytes: mb === null ? null : mb * 1024 * 1024,
  };
}

export interface Measured {
  users: number;
  leads: number;
  storageBytes: number;
  automationRunsThisMonth: number;
}

/** The first moment of the month containing `now` (UTC), and its `YYYY-MM` label. */
export function monthOf(now: Date): { start: Date; period: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, period: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}` };
}

async function storedBytes(db: TenantDb): Promise<number> {
  const files = await db.document.aggregate({
    where: { deletedAt: null, purgedAt: null },
    _sum: { sizeBytes: true },
  });
  return Number(files._sum.sizeBytes ?? 0);
}

export async function measureUsage(db: TenantDb, now = new Date()): Promise<Measured> {
  const [users, leads, storageBytes, runs] = await Promise.all([
    db.user.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
    db.lead.count({ where: { deletedAt: null } }),
    storedBytes(db),
    db.automationRun.count({ where: { createdAt: { gte: monthOf(now).start } } }),
  ]);
  return { users, leads, storageBytes, automationRunsThisMonth: runs };
}

async function planOf(db: TenantDb) {
  const tenant = await db.tenant.findFirst({
    select: { plan: { select: { code: true, name: true, limits: true } } },
  });
  return tenant?.plan
    ? { code: tenant.plan.code, name: tenant.plan.name, limits: parsePlanLimits(tenant.plan.limits) }
    : null;
}

export type Metered = 'users' | 'leads' | 'storage';
const WHAT: Record<Metered, { noun: string; limit: keyof PlanLimits }> = {
  users: { noun: 'active users', limit: 'users' },
  leads: { noun: 'leads', limit: 'leads' },
  storage: { noun: 'of stored documents', limit: 'storageBytes' },
};

const fmtBytes = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;

/**
 * Refuses (409, code `PLAN_LIMIT`) when adding `adding` more of something would pass the plan's limit.
 * Does nothing, and costs nothing, for a workspace whose plan has no limit on it. Only measures what the
 * limit is about, so the common case (no limit) is a single small read.
 */
export async function assertRoom(db: TenantDb, metered: Metered, adding = 1): Promise<void> {
  const plan = await planOf(db);
  const limit = plan?.limits[WHAT[metered].limit];
  if (!plan || limit === null || limit === undefined) return;
  const used =
    metered === 'users'
      ? await db.user.count({ where: { deletedAt: null, status: 'ACTIVE' } })
      : metered === 'leads'
        ? await db.lead.count({ where: { deletedAt: null } })
        : await storedBytes(db);
  if (used + adding <= limit) return;
  const shown = metered === 'storage' ? fmtBytes(limit) : limit.toLocaleString('en-IN');
  const have = metered === 'storage' ? fmtBytes(used) : used.toLocaleString('en-IN');
  throw conflict(
    `Your ${plan.name} plan has room for ${shown} ${WHAT[metered].noun}, and this workspace already has ${have}. Ask your platform administrator to move the workspace to a bigger plan.`,
    { code: 'PLAN_LIMIT', metered, limit, used, adding, plan: plan.code },
  );
}

export interface UsageLine {
  key: 'users' | 'leads' | 'storage' | 'automationRuns';
  label: string;
  used: number;
  /** Null: no limit. */
  limit: number | null;
  /** 0–100 (capped), or null when there is no limit. */
  percent: number | null;
  state: 'ok' | 'near' | 'full' | 'unlimited';
}

/** What the Settings page shows an admin: the plan, and each thing used against its limit. */
export async function getUsage(ctx: Ctx, now = new Date()) {
  authorize(ctx, 'billing:view');
  return withTenant(ctx.tenantId, async (db) => {
    const [plan, measured] = await Promise.all([planOf(db), measureUsage(db, now)]);
    const line = (key: UsageLine['key'], label: string, used: number, limit: number | null): UsageLine => {
      const percent =
        limit === null ? null : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
      return {
        key,
        label,
        used,
        limit,
        percent,
        state: limit === null ? 'unlimited' : used >= limit ? 'full' : percent! >= 80 ? 'near' : 'ok',
      };
    };
    const limits = plan?.limits ?? { users: null, leads: null, storageBytes: null };
    return {
      plan: plan ? { code: plan.code, name: plan.name } : null,
      period: monthOf(now).period,
      lines: [
        line('users', 'Active users', measured.users, limits.users),
        line('leads', 'Leads', measured.leads, limits.leads),
        line('storage', 'Stored documents', measured.storageBytes, limits.storageBytes),
        line('automationRuns', 'Automation runs this month', measured.automationRunsThisMonth, null),
      ],
    };
  });
}

export const USAGE_METRICS = ['users', 'leads', 'storage_bytes', 'automation_runs'] as const;

/**
 * Writes this month's usage of one workspace into `usage_counters` (one row per metric and month,
 * updated in place), so a billing system can read a stable number. Safe to run as often as you like;
 * the worker does it hourly for every workspace.
 */
export async function snapshotTenantUsage(tenantId: string, now = new Date()): Promise<Measured> {
  const { period } = monthOf(now);
  return withTenant(
    tenantId,
    async (db) => {
      const measured = await measureUsage(db, now);
      const values: Record<(typeof USAGE_METRICS)[number], number> = {
        users: measured.users,
        leads: measured.leads,
        storage_bytes: measured.storageBytes,
        automation_runs: measured.automationRunsThisMonth,
      };
      for (const metric of USAGE_METRICS) {
        const value = BigInt(values[metric]);
        const updated = await db.usageCounter.updateMany({ where: { metric, period }, data: { value } });
        if (updated.count === 0) {
          await db.usageCounter.createMany({
            data: [{ metric, period, value } as never],
            skipDuplicates: true,
          });
        }
      }
      return measured;
    },
    { timeoutMs: 60_000 },
  );
}
