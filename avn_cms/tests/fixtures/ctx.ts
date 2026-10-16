import type { Ctx } from '@avn-cms/core';

export function ctxFor(
  user: { id: string; tenantId: string | null; roleCode: Ctx['role'] },
  actingTenantId?: string,
): Ctx {
  if (user.roleCode === 'SUPER_ADMIN') {
    return { tenantId: actingTenantId!, userId: user.id, role: 'SUPER_ADMIN', impersonatedBy: user.id };
  }
  return { tenantId: user.tenantId!, userId: user.id, role: user.roleCode };
}
