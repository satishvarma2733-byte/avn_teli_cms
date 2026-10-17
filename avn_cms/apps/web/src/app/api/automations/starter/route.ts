import { automation } from '@avn-cms/core';

import { ok, route } from '@/lib/api';

/** Add the starter rules this workspace is missing (all switched on). Safe to repeat. */
export const POST = route({ action: 'automation:manage', limit: 20 }, async ({ ctx }) =>
  ok(await automation.installStarterRules(ctx)),
);
