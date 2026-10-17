import { automation } from '@avn-cms/core';
import { rulePatchSchema } from '@avn-cms/core/automation';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/** Edit a rule, or switch it on or off (`{ "isActive": false }`). */
export const PATCH = route({ action: 'automation:manage', limit: 120 }, async ({ req, ctx, params }) =>
  ok(await automation.updateRule(ctx, z.uuid().parse(params['id']), await jsonBody(req, rulePatchSchema))),
);

/** Delete a rule together with its run log. */
export const DELETE = route({ action: 'automation:manage', limit: 60 }, async ({ ctx, params }) =>
  ok(await automation.deleteRule(ctx, z.uuid().parse(params['id']))),
);
