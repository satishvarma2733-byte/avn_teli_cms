import { followups } from '@avn-cms/core';
import { followupUpdateSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/** Reschedule, or log a disposition (optionally applying the suggested stage and booking the next call). */
export const PATCH = route({ limit: 120 }, async ({ req, ctx, params }) => {
  const dto = await jsonBody(req, followupUpdateSchema);
  return ok(await followups.update(ctx, z.uuid().parse(params['id']), dto));
});
