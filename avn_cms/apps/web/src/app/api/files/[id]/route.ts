import { openDownload } from '@avn-cms/core';
import { z } from 'zod';

import { route } from '@/lib/api';

/**
 * Signed, expiring download (exports, import error reports). Needs the session of the user
 * the link was made for, plus a valid `exp`/`sig`; otherwise 404. Every download is audited.
 */
export const GET = route({ limit: 120, bucket: 'files' }, async ({ req, ctx, params }) => {
  const id = z.uuid().parse(params['id']);
  const file = await openDownload(
    ctx,
    id,
    req.nextUrl.searchParams.get('exp'),
    req.nextUrl.searchParams.get('sig'),
  );
  if (file.expired) {
    return new Response('This download link has expired. Go back and click Download again.', {
      status: 410,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const safeName = file.filename.replace(/[^\w.\- ]+/g, '_');
  return new Response(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(file.data.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
