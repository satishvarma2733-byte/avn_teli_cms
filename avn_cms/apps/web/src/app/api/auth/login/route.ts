import { login, loginSchema, validateSession } from '@avn-cms/auth';
import { NextResponse } from 'next/server';

import { errorResponse, jsonBody, route } from '@/lib/api';
import { setSessionCookie } from '@/lib/cookies';
import { landingPath } from '@/lib/session';

/**
 * One answer for every way a sign-in can fail for a person: wrong workspace, unknown email, wrong
 * password, disabled account, or an account paused after too many attempts. Telling them apart would
 * let anyone find out which emails have accounts (a paused account would give itself away after five
 * tries). Only a suspended workspace is named, because that is a fact about the workspace.
 */
const MESSAGES = {
  INVALID_CREDENTIALS:
    'The workspace, email or password is incorrect. After several wrong attempts sign-in pauses for a while; you can also reset your password.',
  SUSPENDED: 'This workspace is suspended. Contact your administrator.',
} as const;

export const POST = route(
  { access: 'public', browserOnly: true, limit: 10, bucket: 'auth-login' },
  async ({ req, ip, userAgent }) => {
    const input = await jsonBody(req, loginSchema);
    const result = await login(input, { ip, userAgent });
    if (!result.ok) {
      return errorResponse(
        'UNAUTHENTICATED',
        MESSAGES[result.reason === 'SUSPENDED' ? 'SUSPENDED' : 'INVALID_CREDENTIALS'],
      );
    }
    const principal = await validateSession(result.token);
    const redirectTo = result.mfaRequired
      ? '/login/mfa'
      : principal?.mfaSetupRequired
        ? '/login/mfa-setup'
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
