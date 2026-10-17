import { getMfaStatus } from '@avn-cms/auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getPrincipal, landingPath } from '@/lib/session';

import { MfaSetup } from './mfa-setup';

export const metadata: Metadata = { title: 'Set up two-step verification' };

/** Where a role that must use two-step verification lands until it has turned it on. */
export default async function MfaSetupPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (principal.mfaEnabled && !principal.mfaVerified) redirect('/login/mfa');
  const mfa = await getMfaStatus(principal.userId);
  return (
    <>
      <h1 className="text-lg font-semibold">Set up two-step verification</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your role has to use a code from an authenticator app each time you sign in.
      </p>
      <div className="mt-6">
        <MfaSetup
          csrf={principal.csrfToken}
          enabled={mfa.enabled}
          recoveryCodesLeft={mfa.recoveryCodesLeft}
          next={landingPath(principal)}
        />
      </div>
    </>
  );
}
