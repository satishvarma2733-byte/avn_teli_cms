import { login, loginSchema, validateSession } from '@avn-cms/auth';
import { NextResponse } from 'next/server';

import { errorResponse, jsonBody, route } from '@/lib/api';
import { setSessionCookie } from '@/lib/cookies';
import { landingPath } from '@/lib/session';

const MESSAGES = {
  INVALID_CREDENTIALS: 'The workspace, email or password is incorrect.',
  LOCKED: 'Too many failed attempts. Try again later or reset your password.',
  SUSPENDED: 'This workspace is suspended. Contact your administrator.',
} as const;

export const POST = route(
  { access: 'public', limit: 10, bucket: 'auth-login' },
  async ({ req, ip, userAgent }) => {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== req.nextUrl.host)
      return errorResponse('FORBIDDEN', 'Cross-site sign-in is not allowed.');

    const input = await jsonBody(req, loginSchema);
    const result = await login(input, { ip, userAgent });
    if (!result.ok) {
      return errorResponse(
        result.reason === 'LOCKED' ? 'RATE_LIMITED' : 'UNAUTHENTICATED',
        MESSAGES[result.reason],
        undefined,
        result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : undefined,
      );
    }
    const principal = await validateSession(result.token);
    const redirectTo = result.mfaRequired
      ? '/login/mfa'
      : principal
        ? landingPath(principal)
        : '/app/dashboard';
    const res = NextResponse.json(
      { data: { redirectTo, mfaRequired: result.mfaRequired } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    setSessionCookie(res, result.token, result.expiresAt);
    return res;
  },
);
