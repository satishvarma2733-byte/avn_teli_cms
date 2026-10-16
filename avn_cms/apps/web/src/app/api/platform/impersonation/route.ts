import { platform } from '@avn-cms/core';

import { ok, route } from '@/lib/api';

/** Stop impersonating. */
export const DELETE = route({ access: 'principal', limit: 20 }, async ({ principal, ip, userAgent }) =>
  ok(await platform.stopImpersonation(principal, { ip, ...(userAgent ? { userAgent } : {}) })),
);
