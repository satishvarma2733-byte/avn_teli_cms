import { leads } from '@avn-cms/core';
import { noteCreateSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

export const POST = route({ limit: 120 }, async ({ req, ctx, params }) => {
  const { body } = await jsonBody(req, noteCreateSchema);
  return ok(await leads.addNote(ctx, z.uuid().parse(params['id']), body), undefined, 201);
});
