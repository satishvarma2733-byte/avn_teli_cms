import { tenantSettings } from '@avn-cms/core';

import { jsonBody, ok, route } from '@/lib/api';

export const POST = route({ action: 'settings:manage', limit: 30 }, async ({ req, ctx }) => {
  const dto = await jsonBody(req, tenantSettings.sourceCreateSchema);
  return ok(await tenantSettings.createSource(ctx, dto), undefined, 201);
});
