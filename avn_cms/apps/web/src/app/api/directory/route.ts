import { directory } from '@avn-cms/core';
import { z } from 'zod';

import { ok, query, route } from '@/lib/api';

const q = z.object({ kind: z.enum(['sources', 'counselors', 'telecallers']) });

/** Picker data: lead sources (everyone) and assignable users (only callers who can assign). */
export const GET = route({}, async ({ req, ctx }) => {
  const { kind } = query(req, q);
  if (kind === 'sources') return ok(await directory.listSources(ctx));
  return ok(await directory.listAssignees(ctx, kind === 'counselors' ? 'COUNSELOR' : 'TELECALLER'));
});
