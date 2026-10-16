import { platform } from '@avn-cms/core';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/** Suspend / reactivate a tenant. */
export const PATCH = route(
  { access: 'principal', limit: 30 },
  async ({ req, principal, params, ip, userAgent }) => {
    const { status } = await jsonBody(req, platform.tenantStatusSchema);
    return ok(
      await platform.setTenantStatus(principal, z.uuid().parse(params['id']), status, {
        ip,
        ...(userAgent ? { userAgent } : {}),
      }),
    );
  },
);
