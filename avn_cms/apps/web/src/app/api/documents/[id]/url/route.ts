import { documents } from '@avn-cms/core';
import { documentUrlQuerySchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { ok, query, route } from '@/lib/api';

/**
 * A signed URL for a clean file: 1 minute for a download, 5 for a preview. Writing the audit row is part
 * of issuing it, so every download has a record. A file still being checked, or blocked, gets a 409 instead.
 */
export const GET = route({ limit: 120, bucket: 'documents-url' }, async ({ req, ctx, params }) => {
  const { disposition } = query(req, documentUrlQuerySchema);
  return ok(await documents.documentUrl(ctx, z.uuid().parse(params['id']), disposition));
});
