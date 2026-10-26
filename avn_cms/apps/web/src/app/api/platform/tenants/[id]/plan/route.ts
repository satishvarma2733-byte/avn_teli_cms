import { platform } from '@avn-cms/core';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/** Move an agency to another plan (refused when it already uses more than the new plan allows). */
export const PATCH = route(
  { roles: ['SUPER_ADMIN'], access: 'principal', limit: 30 },
  async ({ req, principal, params, ip, userAgent }) => {
    const { planCode } = await jsonBody(req, platform.tenantPlanSchema);
    return ok(
      await platform.setTenantPlan(principal, z.uuid().parse(params['id']), planCode, {
        ip,
        ...(userAgent ? { userAgent } : {}),
      }),
    );
  },
);
