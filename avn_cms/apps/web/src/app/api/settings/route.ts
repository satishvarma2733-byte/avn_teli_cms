import { tenantSettings } from '@avn-cms/core';

import { jsonBody, ok, route } from '@/lib/api';

export const GET = route({}, async ({ ctx }) => ok(await tenantSettings.getSettings(ctx)));

export const PATCH = route({ limit: 30 }, async ({ req, ctx }) => {
  const dto = await jsonBody(req, tenantSettings.settingsUpdateSchema);
  return ok(await tenantSettings.updateSettings(ctx, dto));
});
