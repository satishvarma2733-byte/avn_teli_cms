import { users } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

export const POST = route({ action: 'user:resetPassword', limit: 20 }, async ({ ctx, params }) =>
  ok(await users.adminResetPassword(ctx, z.uuid().parse(params['id']))),
);
