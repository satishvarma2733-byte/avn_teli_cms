import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Alert, PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { ImportWizard } from './import-wizard';

export const metadata: Metadata = { title: 'Import' };

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireTenantPage();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  if (!can(ctx, 'import:run')) {
    return (
      <>
        <PageHeader title="Import students" />
        <Alert tone="info">Only admins can import students.</Alert>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Import students" description="Match the columns, check the file, then import it." />
      <ImportWizard id={id} />
    </>
  );
}
