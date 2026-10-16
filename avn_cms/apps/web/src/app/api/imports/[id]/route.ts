import { imports } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

export const GET = route({ limit: 600 }, async ({ ctx, params }) =>
  ok(await imports.getImport(ctx, z.uuid().parse(params['id']))),
);

/** Cancel an import that hasn't started. */
export const DELETE = route({ limit: 30 }, async ({ ctx, params }) =>
  ok(await imports.cancelImport(ctx, z.uuid().parse(params['id']))),
);
