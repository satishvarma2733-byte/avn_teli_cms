import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getPrincipal, landingPath } from '@/lib/session';

import { MfaForm } from './mfa-form';

export const metadata: Metadata = { title: 'Two-step verification' };

export default async function MfaPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (!principal.mfaEnabled || principal.mfaVerified) redirect(landingPath(principal));
  return (
    <>
      <h1 className="text-lg font-semibold">Two-step verification</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter the 6-digit code from your authenticator app.
      </p>
      <MfaForm csrf={principal.csrfToken} />
    </>
  );
}
