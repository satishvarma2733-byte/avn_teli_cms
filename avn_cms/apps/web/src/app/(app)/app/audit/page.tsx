import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { AuditTable } from './audit-table';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage() {
  const { ctx } = await requireTenantPage();
  if (!can(ctx, 'audit:view')) redirect('/app/dashboard');
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who changed what, and when. Entries can't be edited or deleted."
      />
      <AuditTable />
    </>
  );
}
