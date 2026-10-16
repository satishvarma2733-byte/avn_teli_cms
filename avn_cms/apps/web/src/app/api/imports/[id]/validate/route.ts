import { imports } from '@avn-cms/core';
import { importOptionsSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/** Steps 2–4: confirm the column mapping and run the dry run in the background. */
export const POST = route({ limit: 30 }, async ({ req, ctx, params }) => {
  const options = await jsonBody(req, importOptionsSchema);
  return ok(await imports.startValidation(ctx, z.uuid().parse(params['id']), options), undefined, 202);
});
