import { auditAuth, listSessions, revokeOtherSessions } from '@avn-cms/auth';

import { ok, route } from '@/lib/api';

export const GET = route({ access: 'principal' }, async ({ principal }) => {
  const sessions = await listSessions(principal.userId);
  return ok(sessions.map((s) => ({ ...s, current: s.id === principal.sessionId })));
});

/** "Log out other devices". */
export const DELETE = route({ access: 'principal', limit: 10 }, async ({ principal, ip, userAgent }) => {
  const count = await revokeOtherSessions(principal.userId, principal.sessionId);
  await auditAuth({
    tenantId: principal.tenantId,
    userId: principal.userId,
    action: 'auth.sessions_revoked',
    newValue: { count },
    ip,
    userAgent,
  });
  return ok({ revoked: count });
});
