import { tenantSettings } from '@avn-cms/core';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

export const PATCH = route({ limit: 30 }, async ({ req, ctx, params }) => {
  const dto = await jsonBody(req, tenantSettings.sourceUpdateSchema);
  return ok(await tenantSettings.updateSource(ctx, z.uuid().parse(params['id']), dto));
});
