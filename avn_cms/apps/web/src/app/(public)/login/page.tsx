import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getPrincipal, landingPath } from '@/lib/session';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const principal = await getPrincipal();
  if (principal && (!principal.mfaEnabled || principal.mfaVerified)) redirect(landingPath(principal));
  const sp = await searchParams;
  const next =
    typeof sp['next'] === 'string' && sp['next'].startsWith('/') && !sp['next'].startsWith('//')
      ? sp['next']
      : undefined;
  return (
    <>
      <h1 className="text-lg font-semibold">Sign in to aVn CMS</h1>
      <p className="mt-1 text-sm text-muted-foreground">Use your workspace, email and password.</p>
      <LoginForm next={next} reset={sp['reset'] === '1'} />
    </>
  );
}
