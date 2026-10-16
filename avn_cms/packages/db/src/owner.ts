import { getConfig } from '@avn-cms/config';

import { sharedClient, type BaseClient } from './client';

/**
 * The owner client bypasses row-level security. Only packages/auth (sessions, login lookups,
 * intake-credential lookups) and the platform (super-admin) module may import this file;
 * ESLint blocks it everywhere else (docs/MODULE_STRUCTURE.md).
 */
export function ownerDb(): BaseClient {
  return sharedClient(getConfig().DATABASE_OWNER_URL, { poolMax: 5 });
}
