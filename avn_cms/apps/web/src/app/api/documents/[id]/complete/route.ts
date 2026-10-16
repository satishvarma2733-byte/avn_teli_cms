import { documents } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

/**
 * Step 2 of an upload: the browser says the file is in storage. The server checks it arrived at the
 * declared size and queues the safety scan; the file stays unavailable until the scan is clean.
 */
export const POST = route({ limit: 120, bucket: 'documents-complete' }, async ({ ctx, params }) =>
  ok(await documents.completeUpload(ctx, z.uuid().parse(params['id']))),
);
