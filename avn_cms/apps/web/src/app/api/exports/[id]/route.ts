import { exportsService } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

export const GET = route({ limit: 600 }, async ({ ctx, params }) =>
  ok(await exportsService.getExport(ctx, z.uuid().parse(params['id']))),
);
