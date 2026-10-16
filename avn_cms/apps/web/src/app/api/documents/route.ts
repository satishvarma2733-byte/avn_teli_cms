import { documents } from '@avn-cms/core';
import { documentInitSchema, documentListQuerySchema } from '@avn-cms/core/schemas';

import { jsonBody, ok, query, route } from '@/lib/api';

/** Files in a folder of the vault, or matching a search. Admins only. */
export const GET = route({}, async ({ req, ctx }) =>
  ok(await documents.listDocuments(ctx, query(req, documentListQuerySchema))),
);

/**
 * Step 1 of an upload: checks the file, records it as pending and returns a presigned URL the
 * browser PUTs the bytes to. Nothing here carries the file itself.
 */
export const POST = route({ limit: 60, bucket: 'documents-init' }, async ({ req, ctx }) =>
  ok(await documents.initUpload(ctx, await jsonBody(req, documentInitSchema)), undefined, 201),
);
