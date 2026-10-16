import { withTenant } from '@avn-cms/db';

import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { notFound } from '../shared/errors';
import { readFile, verifyDownload } from './files';

/**
 * Serves a stored file to a signed-in user holding a valid, unexpired link made for them.
 * Exports belong to the person who asked for them; import files to the tenant's admins.
 * Anything else answers 404 so file ids can't be probed. Every download is audited.
 */
export async function openDownload(ctx: Ctx, fileId: string, exp: string | null, sig: string | null) {
  const check = verifyDownload(fileId, ctx.userId, exp, sig);
  if (check === 'invalid') throw notFound('File');
  return withTenant(ctx.tenantId, async (db) => {
    const file = await readFile(db, fileId);
    if (!file || (file.expiresAt && file.expiresAt.getTime() < Date.now())) throw notFound('File');
    const own = file.createdById === ctx.userId;
    const adminImportFile =
      (ctx.role === 'TENANT_ADMIN' || ctx.role === 'SUPER_ADMIN') && file.purpose !== 'EXPORT';
    if (!own && !adminImportFile) throw notFound('File');
    if (check === 'expired') return { expired: true as const };
    await audit(
      db,
      ctx,
      file.purpose === 'EXPORT' ? 'export.downloaded' : 'file.downloaded',
      'stored_file',
      file.id,
      undefined,
      {
        filename: file.filename,
        sizeBytes: file.sizeBytes,
      },
    );
    return {
      expired: false as const,
      filename: file.filename,
      mimeType: file.mimeType,
      data: Buffer.from(file.data),
    };
  });
}
