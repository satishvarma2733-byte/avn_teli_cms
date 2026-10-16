import { Prisma } from '../generated/prisma/client';

import type { BaseClient } from './client';

/**
 * Tenant-owned models: every row carries tenant_id. Add each new tenant model here in the
 * same change that creates it — a unit test compares this list with schema.prisma.
 */
export const TENANT_MODELS = [
  'User',
  'Subscription',
  'UsageCounter',
  'LeadSource',
  'Student',
  'Lead',
  'LeadAssignment',
  'LeadStatusHistory',
  'FollowUp',
  'Activity',
  'Note',
  'IntakeCredential',
  'WebLead',
  'Folder',
  'Document',
  'StudentDocument',
  'ImportJob',
  'ExportJob',
  'Notification',
  'AutomationRule',
  'AutomationRun',
  'AuditLog',
] as const;
const tenantModels = new Set<string>(TENANT_MODELS);

export class TenantScopeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeViolation';
  }
}

/** Operations whose filter can be narrowed by tenant_id. */
const FILTERED = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);
/** Unique-key operations would ignore the tenant; refused on tenant models. */
const REFUSED = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);

type Args = { where?: unknown; data?: unknown };

function checkData(model: string, data: unknown, tenantId: string): Record<string, unknown> {
  const row = { ...(data as Record<string, unknown>) };
  if ('tenantId' in row && row['tenantId'] !== tenantId) {
    throw new TenantScopeViolation(`${model}: tenantId differs from the request's tenant`);
  }
  if ('tenant' in row) {
    throw new TenantScopeViolation(`${model}: set the tenant through the scoped client, not a relation`);
  }
  return row;
}

/** The query extension that pins every tenant-model operation to one tenant (ARCHITECTURE §2, layer 2). */
function scopeExtension(tenantId: string) {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!tenantModels.has(model)) return query(args);
          const a = { ...(args as Args) };
          if (REFUSED.has(operation)) {
            throw new TenantScopeViolation(
              `${model}.${operation} can't be tenant-scoped; use findFirst / updateMany / deleteMany`,
            );
          }
          if (FILTERED.has(operation)) {
            a.where = a.where ? { AND: [a.where, { tenantId }] } : { tenantId };
            if (a.data !== undefined) a.data = checkData(model, a.data, tenantId);
          } else if (CREATES.has(operation)) {
            a.data = Array.isArray(a.data)
              ? a.data.map((d) => ({ ...checkData(model, d, tenantId), tenantId }))
              : { ...checkData(model, a.data, tenantId), tenantId };
          } else {
            throw new TenantScopeViolation(`${model}.${operation} is not supported on tenant models`);
          }
          return query(a as typeof args);
        },
      },
    },
  });
}

function scoped(base: BaseClient, tenantId: string) {
  return base.$extends(scopeExtension(tenantId));
}

type Scoped = ReturnType<typeof scoped>;
/** The client a repository receives: tenant-scoped, inside a transaction with RLS set. */
export type TenantDb = Parameters<Parameters<Scoped['$transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantTxOptions {
  /** Longest the transaction may run (default 15 s). */
  timeoutMs?: number;
}

/**
 * Runs `fn` in one transaction that (1) sets `app.tenant_id` for Postgres RLS and (2) hands
 * `fn` a client that injects tenant_id into every tenant-model query. Both layers apply:
 * the app-level scope is primary, RLS is the backstop (ARCHITECTURE §2).
 */
export async function runInTenant<T>(
  base: BaseClient,
  tenantId: string,
  fn: (db: TenantDb) => Promise<T>,
  options: TenantTxOptions = {},
): Promise<T> {
  if (!UUID.test(tenantId)) throw new TenantScopeViolation('tenantId must be a UUID');
  return scoped(base, tenantId).$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { maxWait: 5_000, timeout: options.timeoutMs ?? 15_000 },
  );
}
