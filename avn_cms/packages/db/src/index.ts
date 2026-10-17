import { getConfig } from '@avn-cms/config';

import { sharedClient, type BaseClient } from './client';
import { runInTenant, type TenantDb, type TenantTxOptions } from './tenant';

export { Prisma } from '../generated/prisma/client';
export type * from '../generated/prisma/client';
export * from '../generated/prisma/enums';
export { pingDatabase, disconnectAll, type BaseClient } from './client';
export {
  afterCommit,
  TENANT_MODELS,
  TenantScopeViolation,
  type TenantDb,
  type TenantTxOptions,
} from './tenant';

/**
 * The application client (role avn_app: RLS always applies). Tenant data is only reachable
 * through withTenant(); the owner client lives in '@avn-cms/db/owner' and is restricted to
 * the auth and platform modules.
 */
export function appDb(): BaseClient {
  return sharedClient(getConfig().DATABASE_URL);
}

/** Run tenant-scoped work in one transaction (tenant_id injected + RLS set). */
export function withTenant<T>(
  tenantId: string,
  fn: (db: TenantDb) => Promise<T>,
  options?: TenantTxOptions,
): Promise<T> {
  return runInTenant(appDb(), tenantId, fn, options);
}
