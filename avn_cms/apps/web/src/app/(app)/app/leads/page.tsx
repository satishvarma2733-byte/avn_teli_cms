import { can } from '@avn-cms/core/policy';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { ExportButton } from '@/components/exports/export-button';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { LEAD_FILTER_KEYS } from './filter-keys';
import { LeadsWorkspace } from './leads-workspace';

export const metadata: Metadata = { title: 'Leads' };

export default async function LeadsPage() {
  const { ctx } = await requireTenantPage();
  return (
    <>
      <PageHeader
        title="Leads"
        description="Every student enquiry and where it stands."
        actions={
          <>
            {can(ctx, 'export:run') && (
              <Suspense>
                <ExportButton entity="leads" keys={LEAD_FILTER_KEYS} />
              </Suspense>
            )}
            {can(ctx, 'student:create') && (
              <Link href="/app/leads/new" className={buttonVariants()}>
                <Plus /> Add student
              </Link>
            )}
          </>
        }
      />
      <Suspense>
        <LeadsWorkspace
          role={ctx.role}
          canBulk={can(ctx, 'student:bulk')}
          canFilterByAssignee={can(ctx, 'lead:assignCounselor')}
        />
      </Suspense>
    </>
  );
}
