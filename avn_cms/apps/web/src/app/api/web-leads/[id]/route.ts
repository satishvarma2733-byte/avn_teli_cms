import { webLeads } from '@avn-cms/core';
import { webLeadStatusSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

export const GET = route({ action: 'webLead:view' }, async ({ ctx, params }) =>
  ok(await webLeads.getWebLead(ctx, z.uuid().parse(params['id']))),
);

/** Mark duplicate / spam / rejected (or back to new). */
export const PATCH = route(
  { roles: ['TENANT_ADMIN', 'SUPER_ADMIN'], limit: 120 },
  async ({ req, ctx, params }) => {
    const { status } = await jsonBody(req, webLeadStatusSchema);
    return ok(await webLeads.setStatus(ctx, z.uuid().parse(params['id']), status));
  },
);
