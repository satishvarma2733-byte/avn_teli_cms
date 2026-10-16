import type { Prisma, TenantDb } from '@avn-cms/db';

import type { Ctx } from './context';

/**
 * Appends an audit row inside the caller's transaction, so the change and its audit entry
 * commit together (ARCHITECTURE §3 step 7). Values are plain JSON snapshots.
 */
export async function audit(
  db: TenantDb,
  ctx: Ctx,
  action: string,
  entityType: string,
  entityId: string | null,
  oldValue?: unknown,
  newValue?: unknown,
): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: ctx.userId,
      action,
      entityType,
      entityId,
      ...(oldValue !== undefined ? { oldValue: toJson(oldValue) } : {}),
      ...(newValue !== undefined ? { newValue: toJson(newValue) } : {}),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      impersonatedBy: ctx.impersonatedBy ?? null,
    } as Prisma.AuditLogUncheckedCreateInput,
  });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}
