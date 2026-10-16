import { documents } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

/** The document and all its versions. */
export const GET = route({}, async ({ ctx, params }) =>
  ok(await documents.getDocument(ctx, z.uuid().parse(params['id']))),
);

/** Removes every version from view; the stored files are purged by the worker after 30 days. */
export const DELETE = route({ limit: 60 }, async ({ ctx, params }) =>
  ok(await documents.deleteDocument(ctx, z.uuid().parse(params['id']))),
);
