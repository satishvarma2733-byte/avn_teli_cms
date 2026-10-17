import 'server-only';

import { contextFor, SESSION_COOKIE, validateSession, type Ctx, type Principal } from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import { clientIpFrom } from '@avn-cms/core';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

/** The signed-in principal for this request (once per request), or null. */
export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const jar = await cookies();
  return validateSession(jar.get(SESSION_COOKIE)?.value);
});

async function requestMeta() {
  const h = await headers();
  return {
    ip: clientIpFrom((name) => h.get(name), getConfig().TRUSTED_PROXY_HOPS),
    userAgent: h.get('user-agent') ?? undefined,
  };
}

/** For pages under /app: a fully signed-in principal with a tenant context, or a redirect. */
export async function requireTenantPage(): Promise<{ principal: Principal; ctx: Ctx }> {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (principal.mfaEnabled && !principal.mfaVerified) redirect('/login/mfa');
  if (principal.mfaSetupRequired) redirect('/login/mfa-setup');
  const ctx = contextFor(principal, await requestMeta());
  if (!ctx) redirect(principal.role === 'SUPER_ADMIN' ? '/platform' : '/login');
  return { principal, ctx };
}

/** For pages under /platform: a super admin. */
export async function requirePlatformPage(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (principal.mfaEnabled && !principal.mfaVerified) redirect('/login/mfa');
  if (principal.mfaSetupRequired) redirect('/login/mfa-setup');
  if (principal.role !== 'SUPER_ADMIN') redirect('/app/dashboard');
  return principal;
}

/** Where a role lands after sign-in (PAGES_AND_ROUTES "Role landing"). */
export function landingPath(p: Pick<Principal, 'role' | 'actingTenantId'>): string {
  if (p.role === 'SUPER_ADMIN') return p.actingTenantId ? '/app/dashboard' : '/platform';
  if (p.role === 'TELECALLER') return '/app/followups';
  return '/app/dashboard';
}
