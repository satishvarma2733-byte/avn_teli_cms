import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { ExportButton } from '@/components/exports/export-button';
import { buttonVariants } from '@/components/ui/button';
import { Alert, PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { WebLeadsInbox } from './web-leads-inbox';

export const metadata: Metadata = { title: 'Web leads' };

/** What the inbox reads from the URL. With no status in the URL the inbox shows New. */
const EXPORT_KEYS = ['status', 'q', 'sourceId'];

export default async function WebLeadsPage() {
  const { ctx } = await requireTenantPage();
  const isAdmin = ctx.role === 'TENANT_ADMIN' || ctx.role === 'SUPER_ADMIN';
  return (
    <>
      <PageHeader
        title="Web leads"
        description="Website and landing-page enquiries, before they become students."
        actions={
          <>
            {isAdmin && (
              <Suspense>
                <ExportButton entity="web_leads" keys={EXPORT_KEYS} defaults={{ status: 'NEW' }} />
              </Suspense>
            )}
            {can(ctx, 'intakeCredential:manage') && (
              <Link href="/app/settings/integrations" className={buttonVariants({ variant: 'secondary' })}>
                Connect a website
              </Link>
            )}
          </>
        }
      />
      {isAdmin ? (
        <Suspense>
          <WebLeadsInbox />
        </Suspense>
      ) : (
        <Alert tone="info">
          Web leads routed to you will appear here once lead routing is switched on by your admin.
        </Alert>
      )}
    </>
  );
}
