import { leads } from '@avn-cms/core';
import { leadUpdateSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

const id = z.uuid();

export const GET = route({}, async ({ ctx, params }) => ok(await leads.getLead(ctx, id.parse(params['id']))));

/** Stage, potential/HOT, interest, assignment — each field is policy-gated separately. */
export const PATCH = route({ limit: 120 }, async ({ req, ctx, params }) => {
  const dto = await jsonBody(req, leadUpdateSchema);
  return ok(await leads.updateLead(ctx, id.parse(params['id']), dto));
});
