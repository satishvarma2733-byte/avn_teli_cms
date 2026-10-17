import { getMfaStatus } from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { AccountPanel } from './account-panel';

export const metadata: Metadata = { title: 'My account' };

export default async function AccountPage() {
  const { principal } = await requireTenantPage();
  const mfa = await getMfaStatus(principal.userId);
  return (
    <>
      <PageHeader title="My account" description={`${principal.name} · ${principal.email}`} />
      <AccountPanel
        mfaEnabled={principal.mfaEnabled}
        recoveryCodesLeft={mfa.recoveryCodesLeft}
        mfaRequired={getConfig().MFA_REQUIRED_ROLES.includes(principal.role)}
      />
    </>
  );
}
