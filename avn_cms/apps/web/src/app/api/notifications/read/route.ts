import { notifications } from '@avn-cms/core';

import { jsonBody, ok, route } from '@/lib/api';

/** Mark some notifications (`{ "ids": [...] }`) or all of them (`{ "all": true }`) as read. */
export const POST = route({ limit: 120 }, async ({ req, ctx }) =>
  ok(await notifications.markRead(ctx, await jsonBody(req, notifications.notificationReadSchema))),
);
