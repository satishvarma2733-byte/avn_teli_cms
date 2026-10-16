import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { ExportsList } from './exports-list';

export const metadata: Metadata = { title: 'Exports' };

export default async function ExportsPage() {
  await requireTenantPage();
  return (
    <>
      <PageHeader
        title="Exports"
        description="Files you asked for. Each one is kept for 7 days, and you see only your own."
      />
      <ExportsList />
    </>
  );
}
