import type { RoleCode } from '@avn-cms/db';

/**
 * The request's tenant context (ARCHITECTURE §2, layer 1). Built from the session only —
 * never from the request body.
 */
export interface Ctx {
  /** The tenant every query is scoped to. For a super admin, the tenant being impersonated. */
  tenantId: string;
  userId: string;
  role: RoleCode;
  /** Set when a super admin acts as this tenant (audited). */
  impersonatedBy?: string;
  ip?: string;
  userAgent?: string;
}

/** A signed-in user, whether or not they currently act inside a tenant. */
export interface Principal {
  sessionId: string;
  userId: string;
  name: string;
  email: string;
  role: RoleCode;
  /** Home tenant (null for platform users). */
  tenantId: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  /** Tenant a super admin is impersonating. */
  actingTenantId: string | null;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  /** The role must use two-step verification (MFA_REQUIRED_ROLES) and has not turned it on yet. */
  mfaSetupRequired: boolean;
  csrfToken: string;
}

/** Tenant context for a principal, or null when they have no tenant to act in. */
export function contextFor(p: Principal, meta: { ip?: string; userAgent?: string } = {}): Ctx | null {
  if (p.role === 'SUPER_ADMIN') {
    if (!p.actingTenantId) return null;
    return { tenantId: p.actingTenantId, userId: p.userId, role: p.role, impersonatedBy: p.userId, ...meta };
  }
  if (!p.tenantId) return null;
  return { tenantId: p.tenantId, userId: p.userId, role: p.role, ...meta };
}
