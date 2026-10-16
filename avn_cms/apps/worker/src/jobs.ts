import { followups } from '@avn-cms/core';
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
