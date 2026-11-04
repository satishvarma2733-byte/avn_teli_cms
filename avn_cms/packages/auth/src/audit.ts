import type { BaseClient, Prisma } from '@avn-cms/db';
import { ownerDb } from '@avn-cms/db/owner';

/**
 * Security-event audit rows written by the auth module (owner client: may be platform-level). Pass the
 * transaction client to commit the row together with the change it records.
 */
export async function auditAuth(
  entry: {
    tenantId: string | null;
    userId: string | null;
    action: string;
    entityType?: string;
    entityId?: string | null;
    newValue?: Prisma.InputJsonValue;
    ip?: string | undefined;
    userAgent?: string | undefined;
    impersonatedBy?: string | null;
  },
  db: Pick<BaseClient, 'auditLog'> = ownerDb(),
): Promise<void> {
  await db.auditLog.create({
    data: {
      tenantId: entry.tenantId,
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType ?? 'user',
      entityId: entry.entityId ?? entry.userId,
      ...(entry.newValue !== undefined ? { newValue: entry.newValue } : {}),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 300) ?? null,
      impersonatedBy: entry.impersonatedBy ?? null,
    },
  });
}
