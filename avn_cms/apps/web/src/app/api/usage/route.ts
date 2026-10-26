import { usage } from '@avn-cms/core';

import { ok, route } from '@/lib/api';

/** The workspace's plan and what it has used of it (users, leads, stored documents, automation runs). */
export const GET = route({ action: 'billing:view' }, async ({ ctx }) => ok(await usage.getUsage(ctx)));
