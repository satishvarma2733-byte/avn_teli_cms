import type { RoleCode } from '@avn-cms/db/enums';

/**
 * The RBAC matrix from docs/RBAC_MATRIX.md, as data. Cell values:
 *  - 'tenant'   any record in the caller's tenant
 *  - 'own'      only records where the caller is an active assignee
 *  - 'self'     the caller's own account
 *  - 'platform' super admin: platform resources, or tenant data only while impersonating (audited)
 *  - 'any'      allowed without an ownership check (e.g. counselor creating a student → auto-assigned)
 *  - null       denied
 */
export type Scope = 'tenant' | 'own' | 'self' | 'platform' | 'any' | null;

export const ACTIONS = [
  'tenant:manage',
  'tenant:impersonate',
  'platform:analytics',
  'billing:manage',
  'billing:view',
  'user:list',
  'user:manage',
  'user:delete',
  'user:resetPassword',
  'account:manage',
  'student:list',
  'student:read',
  'student:create',
  'student:update',
  'student:delete',
  'student:bulk',
  'lead:changeStage',
  'lead:markPotential',
  'lead:assignCounselor',
  'lead:assignTelecaller',
  'followup:view',
  'followup:schedule',
  'followup:logDisposition',
  'note:add',
  'activity:view',
  'webLead:view',
  'webLead:convert',
  'import:run',
  'export:run',
  'report:viewTenant',
  'report:viewOwn',
  'document:manage',
  'studentDoc:verify',
  'automation:manage',
  'audit:view',
  'settings:manage',
  'intakeCredential:manage',
] as const;

export type Action = (typeof ACTIONS)[number];

type Row = Record<RoleCode, Scope>;
const row = (SUPER_ADMIN: Scope, TENANT_ADMIN: Scope, COUNSELOR: Scope, TELECALLER: Scope): Row => ({
  SUPER_ADMIN,
  TENANT_ADMIN,
  COUNSELOR,
  TELECALLER,
});

export const MATRIX: Record<Action, Row> = {
  'tenant:manage': row('platform', null, null, null),
  'tenant:impersonate': row('platform', null, null, null),
  'platform:analytics': row('platform', null, null, null),
  'billing:manage': row('platform', null, null, null),
  'billing:view': row('platform', 'tenant', null, null),
  'user:list': row('platform', 'tenant', null, null),
  'user:manage': row('platform', 'tenant', null, null),
  'user:delete': row('platform', 'tenant', null, null),
  'user:resetPassword': row('platform', 'tenant', null, null),
  'account:manage': row('self', 'self', 'self', 'self'),
  'student:list': row('platform', 'tenant', 'own', 'own'),
  'student:read': row('platform', 'tenant', 'own', 'own'),
  'student:create': row(null, 'tenant', 'any', null),
  'student:update': row(null, 'tenant', 'own', 'own'),
  'student:delete': row(null, 'tenant', null, null),
  'student:bulk': row(null, 'tenant', null, null),
  'lead:changeStage': row(null, 'tenant', 'own', null),
  'lead:markPotential': row(null, 'tenant', 'own', 'own'),
  'lead:assignCounselor': row(null, 'tenant', null, null),
  'lead:assignTelecaller': row(null, 'tenant', 'own', null),
  'followup:view': row('platform', 'tenant', 'own', 'own'),
  'followup:schedule': row(null, 'tenant', 'own', 'own'),
  'followup:logDisposition': row(null, 'tenant', 'own', 'own'),
  'note:add': row(null, 'tenant', 'own', 'own'),
  'activity:view': row('platform', 'tenant', 'own', 'own'),
  'webLead:view': row(null, 'tenant', 'own', null),
  'webLead:convert': row(null, 'tenant', 'own', null),
  'import:run': row(null, 'tenant', null, null),
  'export:run': row('platform', 'tenant', 'own', 'own'),
  'report:viewTenant': row('platform', 'tenant', null, null),
  'report:viewOwn': row(null, 'tenant', 'self', 'self'),
  'document:manage': row(null, 'tenant', 'own', null),
  'studentDoc:verify': row(null, 'tenant', 'own', null),
  'automation:manage': row(null, 'tenant', null, null),
  'audit:view': row('platform', 'tenant', null, null),
  'settings:manage': row(null, 'tenant', null, null),
  'intakeCredential:manage': row(null, 'tenant', null, null),
};

/** Platform-only actions: a super admin may do these without impersonating a tenant. */
export const PLATFORM_ACTIONS: ReadonlySet<Action> = new Set([
  'tenant:manage',
  'tenant:impersonate',
  'platform:analytics',
  'billing:manage',
]);
