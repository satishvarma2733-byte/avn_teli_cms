import { listScope } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Alert, PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { Vault } from './vault';

export const metadata: Metadata = { title: 'Documents' };

export default async function DocumentsPage() {
  const { ctx } = await requireTenantPage();
  if (listScope(ctx, 'document:manage') !== 'tenant') {
    return (
      <>
        <PageHeader title="Documents" />
        <Alert tone="info">
          Only admins manage the folder vault. A student’s own files are on the Documents tab of their lead.
        </Alert>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Documents"
        description="The agency’s own files: brochures, fee sheets, templates. A student’s files are on the Documents tab of their lead."
      />
      <Suspense>
        <Vault />
      </Suspense>
    </>
  );
}
