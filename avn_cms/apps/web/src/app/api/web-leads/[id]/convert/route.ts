import { webLeads } from '@avn-cms/core';
import { webLeadConvertSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

export const POST = route({ limit: 120 }, async ({ req, ctx, params }) => {
  const dto = await jsonBody(req, webLeadConvertSchema);
  return ok(await webLeads.convert(ctx, z.uuid().parse(params['id']), dto), undefined, 201);
});
