import { users } from '@avn-cms/core';
import { transferLeadsSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

export const POST = route({ limit: 20 }, async ({ req, ctx, params }) => {
  const dto = await jsonBody(req, transferLeadsSchema);
  return ok(await users.transferLeads(ctx, z.uuid().parse(params['id']), dto));
});
