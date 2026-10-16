import { can } from '@avn-cms/core/policy';
import { Upload } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { Alert, PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { ImportList } from './import-list';

export const metadata: Metadata = { title: 'Imports' };

export default async function ImportsPage() {
  const { ctx } = await requireTenantPage();
  if (!can(ctx, 'import:run')) {
    return (
      <>
        <PageHeader title="Imports" />
        <Alert tone="info">Only admins can import students.</Alert>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Imports"
        description="Bring students in from a CSV or Excel file. Nothing is saved until you confirm the check."
        actions={
          <Link href="/app/imports/new" className={buttonVariants()}>
            <Upload /> New import
          </Link>
        }
      />
      <ImportList />
    </>
  );
}
