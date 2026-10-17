import { auditLog } from '@avn-cms/core';

import { ok, query, route } from '@/lib/api';

export const GET = route({ action: 'audit:view' }, async ({ req, ctx }) => {
  const page = await auditLog.listAudit(ctx, query(req, auditLog.auditQuerySchema));
  return ok(page.items, { nextCursor: page.nextCursor });
});
