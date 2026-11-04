import { platform } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

/** An agency's admins and whether each has two-step verification on (for resetting it). */
export const GET = route({ roles: ['SUPER_ADMIN'], access: 'principal' }, async ({ principal, params }) =>
  ok(await platform.listTenantAdmins(principal, z.uuid().parse(params['id']))),
);
