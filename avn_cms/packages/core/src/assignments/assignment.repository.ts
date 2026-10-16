import type { Prisma, RoleCode, RoleFunction, TenantDb } from '@avn-cms/db';

import { invalid } from '../shared/errors';

/** Which user roles may hold each assignment function. */
export const ELIGIBLE_ROLES: Record<RoleFunction, RoleCode[]> = {
  COUNSELOR: ['COUNSELOR', 'TENANT_ADMIN'],
  TELECALLER: ['TELECALLER'],
};

export async function activeAssignments(db: TenantDb, leadIds: string[]) {
  if (leadIds.length === 0) return [];
  return db.leadAssignment.findMany({
    where: { leadId: { in: leadIds }, isActive: true },
    select: { leadId: true, roleFunction: true, assigneeId: true },
  });
}

/** Checks the target user is an active member of this tenant with a role that fits the function. */
export async function assertAssignable(
  db: TenantDb,
  userId: string,
  fn: RoleFunction,
): Promise<{ id: string; name: string }> {
  const user = await db.user.findFirst({
    where: { id: userId, status: 'ACTIVE', deletedAt: null, roleCode: { in: ELIGIBLE_ROLES[fn] } },
    select: { id: true, name: true },
  });
  if (!user) {
    throw invalid(fn === 'COUNSELOR' ? 'Choose an active counselor.' : 'Choose an active telecaller.', {
      fields: { [fn === 'COUNSELOR' ? 'counselorId' : 'telecallerId']: 'Not an active user with that role.' },
    });
  }
  return user;
}

/**
 * Replaces the active assignment for one function. History is kept (old row is_active=false),
 * so "who had this lead in March" stays answerable. Returns the previous assignee id.
 */
export async function setAssignment(
  db: TenantDb,
  leadId: string,
  fn: RoleFunction,
  assigneeId: string | null,
  assignedById: string | null,
): Promise<{ previous: string | null; changed: boolean }> {
  const current = await db.leadAssignment.findFirst({ where: { leadId, roleFunction: fn, isActive: true } });
  if ((current?.assigneeId ?? null) === assigneeId)
    return { previous: current?.assigneeId ?? null, changed: false };
  if (current) {
    await db.leadAssignment.updateMany({
      where: { id: current.id },
      data: { isActive: false, endedAt: new Date() },
    });
  }
  if (assigneeId) {
    await db.leadAssignment.create({
      data: {
        leadId,
        assigneeId,
        roleFunction: fn,
        assignedById,
      } as Prisma.LeadAssignmentUncheckedCreateInput,
    });
  }
  return { previous: current?.assigneeId ?? null, changed: true };
}

/**
 * Round-robin: the active user of the role who was picked longest ago (never-picked first).
 * Row lock + SKIP LOCKED so concurrent intakes don't pick the same person twice.
 */
export async function pickRoundRobin(db: TenantDb, fn: RoleFunction): Promise<string | null> {
  const roles = fn === 'COUNSELOR' ? ['COUNSELOR'] : ['TELECALLER'];
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM users
    WHERE tenant_id = app_tenant_id() AND status = 'ACTIVE' AND deleted_at IS NULL
      AND role_code::text = ANY(${roles})
    ORDER BY last_round_robin_at ASC NULLS FIRST, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED`;
  const id = rows[0]?.id ?? null;
  if (id) await db.user.updateMany({ where: { id }, data: { lastRoundRobinAt: new Date() } });
  return id;
}

export async function userNames(
  db: TenantDb,
  ids: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}
