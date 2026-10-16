import { imports } from '@avn-cms/core';
import { importRunSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/** Steps 5–6: choose duplicate behaviour and start the background import. */
export const POST = route({ limit: 30 }, async ({ req, ctx, params }) => {
  const { duplicateMode } = await jsonBody(req, importRunSchema);
  return ok(await imports.startRun(ctx, z.uuid().parse(params['id']), duplicateMode), undefined, 202);
});
