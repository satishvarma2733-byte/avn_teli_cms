import { users } from '@avn-cms/core';
import { userCreateSchema } from '@avn-cms/core/schemas';

import { jsonBody, ok, route } from '@/lib/api';

export const GET = route({}, async ({ ctx }) => ok(await users.listUsers(ctx)));

export const POST = route({ limit: 30 }, async ({ req, ctx }) => {
  const dto = await jsonBody(req, userCreateSchema);
  return ok(await users.createUser(ctx, dto), undefined, 201);
});
