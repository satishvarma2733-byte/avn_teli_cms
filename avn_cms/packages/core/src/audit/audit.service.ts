import { withTenant, type Prisma } from '@avn-cms/db';
import { z } from 'zod';

import { userNames } from '../assignments/assignment.repository';
import { authorize } from '../policy/index';
import type { Ctx } from '../shared/context';
import { decodeKeyset, encodeKeyset, keysetWhere } from '../shared/pagination';
import { dateRange } from '../shared/time';
import { loadSettings } from '../tenants/settings';

export const auditQuerySchema = z.object({
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  actorId: z.uuid().optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Audit log viewer (admin). Read-only: the app role can't update or delete audit rows. */
export async function listAudit(ctx: Ctx, q: z.output<typeof auditQuerySchema>) {
  authorize(ctx, 'audit:view');
  const cursor = decodeKeyset(q.cursor, 'audit');
  return withTenant(ctx.tenantId, async (db) => {
    const { timezone } = await loadSettings(db);
    const range = dateRange(timezone, q.dateFrom, q.dateTo);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorId ? { userId: q.actorId } : {}),
      ...(range.gte || range.lt
        ? { createdAt: { ...(range.gte ? { gte: range.gte } : {}), ...(range.lt ? { lt: range.lt } : {}) } }
        : {}),
    };
    const rows = await db.auditLog.findMany({
      where: { AND: [where, keysetWhere('createdAt', 'desc', cursor)] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const names = await userNames(
      db,
      items.flatMap((r) => [r.userId, r.impersonatedBy]),
    );
    const last = items[items.length - 1];
    return {
      items: items.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        oldValue: r.oldValue,
        newValue: r.newValue,
        ip: r.ip,
        createdAt: r.createdAt,
        actorName: r.userId ? (names.get(r.userId) ?? 'Platform admin') : 'System',
        impersonatedBy: r.impersonatedBy ? (names.get(r.impersonatedBy) ?? 'Platform admin') : null,
      })),
      nextCursor: hasMore && last ? encodeKeyset('audit', last.createdAt, last.id) : null,
    };
  });
}
