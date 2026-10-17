import { automation } from '@avn-cms/core';
import { runListQuerySchema } from '@avn-cms/core/automation';

import { ok, query, route } from '@/lib/api';

/** The run log, newest first; filter with ?ruleId= and ?status=. */
export const GET = route({}, async ({ req, ctx }) => {
  const page = await automation.listRuns(ctx, query(req, runListQuerySchema));
  return ok(page.items, { nextCursor: page.nextCursor });
});
