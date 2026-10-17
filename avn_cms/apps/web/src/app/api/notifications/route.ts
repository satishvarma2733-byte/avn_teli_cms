import { notifications } from '@avn-cms/core';

import { ok, query, route } from '@/lib/api';

/** The signed-in person's own notifications, newest first. */
export const GET = route({}, async ({ req, ctx }) => {
  const page = await notifications.listNotifications(
    ctx,
    query(req, notifications.notificationListQuerySchema),
  );
  return ok(page.items, { nextCursor: page.nextCursor, unread: page.unread });
});
