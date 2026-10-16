import type { RoleCode } from '@avn-cms/db/enums';

import { forbidden } from '../shared/errors';
import { MATRIX, PLATFORM_ACTIONS, type Action, type Scope } from './matrix';

export { ACTIONS, MATRIX, type Action, type Scope } from './matrix';

/** Minimal context the policy needs — pure data, no I/O. */
export interface PolicyCtx {
  tenantId: string | null;
  userId: string;
  role: RoleCode;
  impersonatedBy?: string | undefined;
}

/** The resource being acted on: its tenant and (for ownership checks) its active assignees. */
export interface PolicyResource {
  tenantId: string;
  assigneeIds?: readonly string[];
  /** For 'self' scope: the account the action targets. */
  userId?: string;
}

export function scopeOf(role: RoleCode, action: Action): Scope {
  return MATRIX[action][role];
}

/**
 * Pure permission check (RBAC_MATRIX "Policy function shape"). Tenant first, then role,
 * then ownership. A super admin reaches tenant data only while impersonating that tenant.
 */
export function can(ctx: PolicyCtx, action: Action, resource?: PolicyResource): boolean {
  const scope = scopeOf(ctx.role, action);
  if (scope === null) return false;

  if (ctx.role === 'SUPER_ADMIN') {
    if (PLATFORM_ACTIONS.has(action)) return true;
    if (scope === 'self') return !resource?.userId || resource.userId === ctx.userId;
    // Tenant data: only through audited impersonation of that tenant.
    if (!ctx.impersonatedBy || !ctx.tenantId) return false;
    return !resource || resource.tenantId === ctx.tenantId;
  }

  if (resource && resource.tenantId !== ctx.tenantId) return false;

  switch (scope) {
    case 'tenant':
    case 'any':
      return true;
    case 'self':
      return !resource?.userId || resource.userId === ctx.userId;
    case 'own':
      // Without a resource this answers "may the role do this at all?" (list endpoints then
      // narrow the query to own records).
      return !resource || (resource.assigneeIds ?? []).includes(ctx.userId);
    case 'platform':
      return false;
  }
}

/** Throws FORBIDDEN unless allowed. */
export function authorize(ctx: PolicyCtx, action: Action, resource?: PolicyResource): void {
  if (!can(ctx, action, resource)) throw forbidden();
}

/**
 * For list/read endpoints: 'tenant' → whole tenant, 'own' → only rows assigned to the caller,
 * null → no access. Super admins (impersonating) read tenant-wide where allowed.
 */
export function listScope(ctx: PolicyCtx, action: Action): 'tenant' | 'own' | null {
  if (!can(ctx, action)) return null;
  const scope = scopeOf(ctx.role, action);
  if (scope === 'own') return 'own';
  return 'tenant';
}

/** Telecallers get a reduced student view (no full address / email) — RBAC_MATRIX note. */
export function seesReducedStudentFields(role: RoleCode): boolean {
  return role === 'TELECALLER';
}
