import { documents } from '@avn-cms/core';
import { folderCreateSchema, folderListQuerySchema } from '@avn-cms/core/schemas';

import { jsonBody, ok, query, route } from '@/lib/api';

/** Sub-folders of a folder (or of the vault root), with the path to it. Admins only. */
export const GET = route({ roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] }, async ({ req, ctx }) =>
  ok(await documents.listFolders(ctx, query(req, folderListQuerySchema).parentId)),
);

export const POST = route(
  { roles: ['TENANT_ADMIN', 'SUPER_ADMIN'], limit: 60, bucket: 'folders-create' },
  async ({ req, ctx }) =>
    ok(await documents.createFolder(ctx, await jsonBody(req, folderCreateSchema)), undefined, 201),
);
