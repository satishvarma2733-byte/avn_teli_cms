import { getConfig } from '@avn-cms/config';
import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { IntegrationsPanel } from './integrations-panel';

export const metadata: Metadata = { title: 'Website integrations' };

export default async function IntegrationsPage() {
  const { ctx } = await requireTenantPage();
  if (!can(ctx, 'intakeCredential:manage')) redirect('/app/dashboard');
  return (
    <>
      <div className="mb-2">
        <Link href="/app/settings" className="text-sm text-muted-foreground hover:text-foreground">
          ← Settings
        </Link>
      </div>
      <PageHeader
        title="Website integrations"
        description="Credentials that let your websites and landing pages send enquiries into the Web leads inbox."
      />
      <IntegrationsPanel endpoint={`${getConfig().APP_URL}/api/webleads`} />
    </>
  );
}
