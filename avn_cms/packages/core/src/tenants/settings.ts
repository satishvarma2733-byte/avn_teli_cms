import type { TenantDb } from '@avn-cms/db';

import { tenantTimezone } from '../shared/time';

export interface TenantSettings {
  timezone: string;
  roundRobin: boolean;
  /** Minutes a NEW lead may stay uncontacted before managers are told (automation). */
  uncontactedMinutes: number;
}

/** The current tenant's settings (RLS limits `tenants` to the tenant of the transaction). */
export async function loadSettings(db: TenantDb): Promise<TenantSettings> {
  const t = await db.tenant.findFirst({ select: { settings: true } });
  const s = (t?.settings ?? {}) as Record<string, unknown>;
  return {
    timezone: tenantTimezone(s),
    roundRobin: s['roundRobin'] === true,
    uncontactedMinutes: typeof s['uncontactedMinutes'] === 'number' ? s['uncontactedMinutes'] : 30,
  };
}
