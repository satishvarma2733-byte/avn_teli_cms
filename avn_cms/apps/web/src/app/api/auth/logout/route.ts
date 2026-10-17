import { auditAuth, revokeSession } from '@avn-cms/auth';
import { NextResponse } from 'next/server';

import { route } from '@/lib/api';
import { clearSessionCookie } from '@/lib/cookies';

export const POST = route(
  { access: 'principal', allowPendingMfa: true, limit: 20 },
  async ({ principal, ip, userAgent }) => {
    await revokeSession(principal.sessionId);
    await auditAuth({
      tenantId: principal.tenantId,
      userId: principal.userId,
      action: 'auth.logout',
      ip,
      userAgent,
    });
    const res = NextResponse.json({ data: { redirectTo: '/login' } });
    clearSessionCookie(res);
    return res;
  },
);
