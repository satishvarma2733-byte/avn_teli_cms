import 'server-only';

import { SESSION_COOKIE } from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import type { NextResponse } from 'next/server';

/** Session cookie: httpOnly, SameSite=Lax, Secure outside local http. */
export function setSessionCookie(res: NextResponse, token: string, expiresAt: Date): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: getConfig().APP_URL.startsWith('https://'),
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}
