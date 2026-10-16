import 'server-only';

import { withTenant } from '@avn-cms/db';

/** Name of the tenant a context points at (used for super-admin impersonation). */
export async function tenantName(tenantId: string): Promise<string> {
  const t = await withTenant(tenantId, (db) => db.tenant.findFirst({ select: { name: true } }));
  return t?.name ?? 'Workspace';
}
