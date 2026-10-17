import { platform } from '@avn-cms/core';

import { jsonBody, ok, route } from '@/lib/api';

export const GET = route({ roles: ['SUPER_ADMIN'], access: 'principal' }, async ({ principal }) =>
  ok(await platform.listTenants(principal)),
);

export const POST = route(
  { roles: ['SUPER_ADMIN'], access: 'principal', limit: 20 },
  async ({ req, principal, ip, userAgent }) => {
    const dto = await jsonBody(req, platform.tenantCreateSchema);
    return ok(
      await platform.createTenant(principal, dto, { ip, ...(userAgent ? { userAgent } : {}) }),
      undefined,
      201,
    );
  },
);
