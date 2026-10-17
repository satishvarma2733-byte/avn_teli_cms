import { withTenant } from '@avn-cms/db';
import { z } from 'zod';

import type { Ctx } from '../shared/context';
import { afterCursor, decodeCursor, encodeCursor } from '../shared/pagination';

/**
 * A person's own notifications: what the system (automation rules, escalations) told them. Everyone
 * sees only their own; there is nothing to authorize beyond being signed in to the workspace.
 */
export const notificationListQuerySchema = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const notificationReadSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);

export async function listNotifications(ctx: Ctx, q: z.output<typeof notificationListQuerySchema>) {
  const cursor = decodeCursor(q.cursor);
  return withTenant(ctx.tenantId, async (db) => {
    const rows = await db.notification.findMany({
      where: { userId: ctx.userId, ...(q.unreadOnly ? { readAt: null } : {}), ...afterCursor(cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];
    const unread = await db.notification.count({ where: { userId: ctx.userId, readAt: null } });
    return {
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        entityType: n.entityType,
        entityId: n.entityId,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      unread,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  });
}

export async function unreadCount(ctx: Ctx): Promise<number> {
  return withTenant(ctx.tenantId, (db) =>
    db.notification.count({ where: { userId: ctx.userId, readAt: null } }),
  );
}

export async function markRead(ctx: Ctx, input: z.output<typeof notificationReadSchema>) {
  return withTenant(ctx.tenantId, async (db) => {
    const res = await db.notification.updateMany({
      where: {
        userId: ctx.userId,
        readAt: null,
        ...('ids' in input ? { id: { in: input.ids } } : {}),
      },
      data: { readAt: new Date() },
    });
    return {
      marked: res.count,
      unread: await db.notification.count({ where: { userId: ctx.userId, readAt: null } }),
    };
  });
}
