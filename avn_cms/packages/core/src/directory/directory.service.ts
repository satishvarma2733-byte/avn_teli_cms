import { withTenant, type RoleFunction } from '@avn-cms/db';

import { ELIGIBLE_ROLES } from '../assignments/assignment.repository';
import { can } from '../policy/index';
import type { Ctx } from '../shared/context';
import { forbidden } from '../shared/errors';

/**
 * Small lookups for pickers and filters. Assignee lists expose only id + name + role, and
 * only to callers who can assign (or filter by) that function.
 */
export async function listAssignees(ctx: Ctx, fn: RoleFunction) {
  const allowed =
    can(ctx, fn === 'COUNSELOR' ? 'lead:assignCounselor' : 'lead:assignTelecaller') ||
    can(ctx, 'user:list') ||
    can(ctx, 'student:bulk');
  if (!allowed) throw forbidden();
  return withTenant(ctx.tenantId, (db) =>
    db.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null, roleCode: { in: ELIGIBLE_ROLES[fn] } },
      select: { id: true, name: true, roleCode: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
  );
}

export async function listSources(ctx: Ctx) {
  return withTenant(ctx.tenantId, (db) =>
    db.leadSource.findMany({
      where: { isActive: true },
      select: { id: true, code: true, label: true },
      orderBy: { label: 'asc' },
    }),
  );
}
