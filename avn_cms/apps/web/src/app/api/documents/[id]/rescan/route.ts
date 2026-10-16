import { rescanDocument } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

/** Another try for a file that could not be checked (resets its attempts, queues the scan). Admins only. */
export const POST = route({ limit: 60, bucket: 'documents-rescan' }, async ({ ctx, params }) =>
  ok(await rescanDocument(ctx, z.uuid().parse(params['id'])), undefined, 202),
);
