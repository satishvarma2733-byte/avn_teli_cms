import { users } from '@avn-cms/core';
import { userUpdateSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

export const PATCH = route({ action: 'user:manage', limit: 60 }, async ({ req, ctx, params }) => {
  const dto = await jsonBody(req, userUpdateSchema);
  return ok(await users.updateUser(ctx, z.uuid().parse(params['id']), dto));
});

/** Soft delete; refused until the user's leads and open calls are transferred. */
export const DELETE = route({ action: 'user:delete', limit: 30 }, async ({ ctx, params }) =>
  ok(await users.deleteUser(ctx, z.uuid().parse(params['id']))),
);
