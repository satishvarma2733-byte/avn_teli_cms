import { leads } from '@avn-cms/core';
import { z } from 'zod';

import { ok, query, route } from '@/lib/api';

const q = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const GET = route({}, async ({ req, ctx, params }) => {
  const { cursor, limit } = query(req, q);
  const page = await leads.getTimeline(ctx, z.uuid().parse(params['id']), cursor, limit);
  return ok(page.items, { nextCursor: page.nextCursor });
});
