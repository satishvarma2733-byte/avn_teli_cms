import { exportsService } from '@avn-cms/core';
import { exportCreateSchema } from '@avn-cms/core/schemas';

import { jsonBody, ok, route } from '@/lib/api';

export const GET = route({}, async ({ ctx }) => ok(await exportsService.listExports(ctx)));

/** Records the export and returns at once; the file is written in the background. */
export const POST = route({ limit: 20, bucket: 'exports-create' }, async ({ req, ctx }) => {
  const dto = await jsonBody(req, exportCreateSchema);
  return ok(await exportsService.requestExport(ctx, dto), undefined, 202);
});
