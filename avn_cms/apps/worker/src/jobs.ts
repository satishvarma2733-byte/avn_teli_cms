import { deleteExpiredFiles, failStuckJobs, followups } from '@avn-cms/core';
import { withTenant } from '@avn-cms/db';
import { ownerDb } from '@avn-cms/db/owner';

/**
 * System jobs. Listing tenants is a platform-level read (owner client); all tenant work runs
 * through withTenant, so RLS and the scoped client still apply inside each tenant.
 */
export async function overdueSweepAllTenants(now = new Date()) {
  const tenants = await ownerDb().tenant.findMany({
    where: { status: { not: 'SUSPENDED' } },
    select: { id: true, slug: true },
  });
  const results: { tenant: string; flagged: number; escalated: number }[] = [];
  for (const t of tenants) {
    try {
      const r = await withTenant(t.id, (db) => followups.sweepOverdue(db, now), { timeoutMs: 60_000 });
      results.push({ tenant: t.slug, ...r });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'overdue sweep failed',
          tenant: t.slug,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return results;
}

/** Deletes expired export files and old import uploads/error reports in every tenant. */
export async function expiredFilesSweepAllTenants(now = new Date()) {
  const tenants = await ownerDb().tenant.findMany({ select: { id: true } });
  let deleted = 0;
  for (const t of tenants) deleted += await withTenant(t.id, (db) => deleteExpiredFiles(db, now));
  return { deleted };
}

/**
 * Marks imports and exports whose worker stopped mid-run as FAILED (packages/core/src/jobs/recovery.ts),
 * so the person sees what happened and can start over instead of watching a job that never ends.
 */
export async function stuckJobsSweepAllTenants(now = new Date()) {
  const tenants = await ownerDb().tenant.findMany({ select: { id: true, slug: true } });
  const results: { tenant: string; imports: number; exports: number }[] = [];
  for (const t of tenants) {
    try {
      const r = await withTenant(t.id, (db) => failStuckJobs(db, now), { timeoutMs: 60_000 });
      if (r.imports + r.exports > 0) {
        results.push({ tenant: t.slug, ...r });
        console.warn(JSON.stringify({ level: 'warn', msg: 'recovered stuck jobs', tenant: t.slug, ...r }));
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'stuck jobs sweep failed',
          tenant: t.slug,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return results;
}
