import { platform } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

/** Start acting as this tenant (audited in both the platform and the tenant log). */
export const POST = route(
  { access: 'principal', limit: 20 },
  async ({ principal, params, ip, userAgent }) => {
    const res = await platform.startImpersonation(principal, z.uuid().parse(params['id']), {
      ip,
      ...(userAgent ? { userAgent } : {}),
    });
    return ok({ ...res, redirectTo: '/app/dashboard' });
  },
);
