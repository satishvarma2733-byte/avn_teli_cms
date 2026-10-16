import { leads } from '@avn-cms/core';
import { bulkActionSchema } from '@avn-cms/core/schemas';

import { jsonBody, ok, route } from '@/lib/api';

export const POST = route({ limit: 20 }, async ({ req, ctx }) => {
  const dto = await jsonBody(req, bulkActionSchema, 128 * 1024);
  return ok(await leads.bulkAction(ctx, dto));
});
