import { notifications } from '@avn-cms/core';

import { ok, route } from '@/lib/api';

/** How many unread notifications the signed-in person has (the badge in the navigation). */
export const GET = route({ limit: 600 }, async ({ ctx }) =>
  ok({ unread: await notifications.unreadCount(ctx) }),
);
