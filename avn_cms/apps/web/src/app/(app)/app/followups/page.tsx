import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { FollowupQueue } from './followup-queue';

export const metadata: Metadata = { title: 'Follow-ups' };

export default async function FollowupsPage() {
  const { ctx } = await requireTenantPage();
  const ownOnly = ctx.role === 'COUNSELOR' || ctx.role === 'TELECALLER';
  return (
    <>
      <PageHeader
        title="Follow-ups"
        description={ownOnly ? 'Your call queue.' : 'Every scheduled call across the team.'}
      />
      <Suspense>
        <FollowupQueue
          showAssignee={!ownOnly}
          canChangeStage={can(ctx, 'lead:changeStage') && ctx.role !== 'TELECALLER'}
        />
      </Suspense>
    </>
  );
}
