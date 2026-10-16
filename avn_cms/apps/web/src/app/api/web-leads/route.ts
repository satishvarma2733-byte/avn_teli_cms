import { webLeads } from '@avn-cms/core';
import { webLeadListQuerySchema } from '@avn-cms/core/schemas';

import { ok, query, route } from '@/lib/api';

export const GET = route({}, async ({ req, ctx }) => {
  const page = await webLeads.listInbox(ctx, query(req, webLeadListQuerySchema));
  return ok(page.items, { nextCursor: page.nextCursor, counts: page.counts });
});
