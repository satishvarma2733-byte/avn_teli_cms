import { imports } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

export const GET = route({ action: 'import:run', limit: 600 }, async ({ ctx, params }) =>
  ok(await imports.getImport(ctx, z.uuid().parse(params['id']))),
);

/** Cancel an import that hasn't started. */
export const DELETE = route({ action: 'import:run', limit: 30 }, async ({ ctx, params }) =>
  ok(await imports.cancelImport(ctx, z.uuid().parse(params['id']))),
);
