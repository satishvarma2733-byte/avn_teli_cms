import {
  deleteExpiredFiles,
  failStuckJobs,
  followups,
  maintainDocuments,
  sweepAutomation,
} from '@avn-cms/core';
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
  const results: { tenant: string; flagged: number }[] = [];
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

/**
 * Documents housekeeping in every workspace: queue scans that never ran or failed, remove the
 * stored files of blocked and long-deleted documents, drop uploads that were never completed.
 */
export async function documentMaintenanceAllTenants(now = new Date()) {
  const tenants = await ownerDb().tenant.findMany({
    where: { status: { not: 'SUSPENDED' } },
    select: { id: true, slug: true },
  });
  const results: { tenant: string; requeued: number; purged: number; abandoned: number }[] = [];
  for (const t of tenants) {
    try {
      const r = await maintainDocuments(t.id, now);
      if (r.requeued + r.purged + r.abandoned > 0) results.push({ tenant: t.slug, ...r });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'document maintenance failed',
          tenant: t.slug,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return results;
}

/**
 * Automation housekeeping in every workspace: finds leads nobody has contacted and calls that are
 * overdue (for the rules that watch for them), queues runs that were never handed over, recovers runs
 * a dead worker left half done, and removes old finished runs.
 */
export async function automationSweepAllTenants(now = new Date()) {
  const tenants = await ownerDb().tenant.findMany({
    where: { status: { not: 'SUSPENDED' } },
    select: { id: true, slug: true },
  });
  const results: {
    tenant: string;
    uncontacted: number;
    overdue: number;
    requeued: number;
    recovered: number;
    purged: number;
  }[] = [];
  for (const t of tenants) {
    try {
      const r = await sweepAutomation(t.id, now);
      if (r.uncontacted + r.overdue + r.requeued + r.recovered + r.purged > 0)
        results.push({ tenant: t.slug, ...r });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'automation sweep failed',
          tenant: t.slug,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return results;
}
