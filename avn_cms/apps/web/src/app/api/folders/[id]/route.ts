import { documents } from '@avn-cms/core';
import { folderUpdateSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

export const PATCH = route(
  { roles: ['TENANT_ADMIN', 'SUPER_ADMIN'], limit: 60 },
  async ({ req, ctx, params }) => {
    const { name } = await jsonBody(req, folderUpdateSchema);
    return ok(await documents.renameFolder(ctx, z.uuid().parse(params['id']), name));
  },
);

/** Only an empty folder can be deleted. */
export const DELETE = route({ roles: ['TENANT_ADMIN', 'SUPER_ADMIN'], limit: 30 }, async ({ ctx, params }) =>
  ok(await documents.deleteFolder(ctx, z.uuid().parse(params['id']))),
);
