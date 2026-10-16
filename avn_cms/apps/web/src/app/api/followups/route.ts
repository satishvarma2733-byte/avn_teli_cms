import { followups } from '@avn-cms/core';
import { followupCreateSchema, followupListQuerySchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, query, route } from '@/lib/api';

/** Call queue by bucket; `?counts=1` returns tab badge counts instead. */
export const GET = route({}, async ({ req, ctx }) => {
  if (req.nextUrl.searchParams.get('counts') === '1') {
    const assigneeId = z
      .uuid()
      .optional()
      .parse(req.nextUrl.searchParams.get('assigneeId') ?? undefined);
    return ok(await followups.queueCounts(ctx, assigneeId));
  }
  const page = await followups.listQueue(ctx, query(req, followupListQuerySchema));
  return ok(page.items, { nextCursor: page.nextCursor });
});

export const POST = route({ limit: 120 }, async ({ req, ctx }) => {
  const dto = await jsonBody(req, followupCreateSchema);
  return ok(await followups.schedule(ctx, dto), undefined, 201);
});
