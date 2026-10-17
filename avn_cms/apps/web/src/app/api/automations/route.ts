import { automation, STARTER_RULES } from '@avn-cms/core';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/** The workspace's rules, with how they ran this past week. `missingStarters` drives “Add starter rules”. */
export const GET = route({ action: 'automation:manage' }, async ({ ctx }) => {
  const rules = await automation.listRules(ctx);
  const have = new Set(rules.map((r) => r.starterKey));
  return ok(rules, { missingStarters: STARTER_RULES.filter((s) => !have.has(s.key)).length });
});

/** Create a rule. The body is checked in full by the service, which lists every field that needs work. */
export const POST = route({ action: 'automation:manage', limit: 60 }, async ({ req, ctx }) =>
  ok(
    await automation.createRule(ctx, await jsonBody(req, z.record(z.string(), z.unknown()))),
    undefined,
    201,
  ),
);
