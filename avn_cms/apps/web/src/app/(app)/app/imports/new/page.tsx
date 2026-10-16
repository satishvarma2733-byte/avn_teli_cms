import { can } from '@avn-cms/core/policy';
import { Download } from 'lucide-react';
import type { Metadata } from 'next';

import { buttonVariants } from '@/components/ui/button';
import { Alert, PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { UploadForm } from './upload-form';

export const metadata: Metadata = { title: 'New import' };

export default async function NewImportPage() {
  const { ctx } = await requireTenantPage();
  if (!can(ctx, 'import:run')) {
    return (
      <>
        <PageHeader title="New import" />
        <Alert tone="info">Only admins can import students.</Alert>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="New import"
        description="Step 1 of 4: choose a file. You’ll match its columns on the next screen."
        actions={
          <a href="/api/students/template" download className={buttonVariants({ variant: 'secondary' })}>
            <Download /> Download template
          </a>
        }
      />
      <UploadForm />
    </>
  );
}
