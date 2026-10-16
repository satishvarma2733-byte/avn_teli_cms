import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { ReportsCenter } from './reports-center';

export const metadata: Metadata = { title: 'Reports' };

export default async function ReportsPage() {
  const { ctx } = await requireTenantPage();
  const tenantWide = can(ctx, 'report:viewTenant');
  if (!tenantWide && !can(ctx, 'report:viewOwn')) redirect('/app/dashboard');
  return (
    <>
      <PageHeader
        title={tenantWide ? 'Reports' : 'My performance'}
        description={
          tenantWide
            ? 'Conversion, sources and team performance from live data.'
            : 'Your own leads and calls.'
        }
      />
      <ReportsCenter tenantWide={tenantWide} />
    </>
  );
}
