import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { AccountPanel } from './account-panel';

export const metadata: Metadata = { title: 'My account' };

export default async function AccountPage() {
  const { principal } = await requireTenantPage();
  return (
    <>
      <PageHeader title="My account" description={`${principal.name} · ${principal.email}`} />
      <AccountPanel mfaEnabled={principal.mfaEnabled} />
    </>
  );
}
