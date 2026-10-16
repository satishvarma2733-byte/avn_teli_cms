import { imports, invalid, MAX_FILE_BYTES } from '@avn-cms/core';

import { ok, route } from '@/lib/api';

export const GET = route({}, async ({ ctx }) => ok(await imports.listImports(ctx)));

/** Step 1 of the wizard: upload a .csv/.xlsx file (multipart field "file"). */
export const POST = route({ limit: 20, bucket: 'imports-upload' }, async ({ req, ctx }) => {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_FILE_BYTES + 64 * 1024)
    throw invalid(`Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const form = await req.formData().catch(() => {
    throw invalid('Send the file as multipart/form-data in a field named “file”.');
  });
  const file = form.get('file');
  if (!(file instanceof File)) throw invalid('Choose a file to upload.');
  const data = Buffer.from(await file.arrayBuffer());
  return ok(
    await imports.createDraft(ctx, { filename: file.name, mimeType: file.type, data }),
    undefined,
    201,
  );
});
