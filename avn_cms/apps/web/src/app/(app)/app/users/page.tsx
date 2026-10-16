import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { UsersTable } from './users-table';

export const metadata: Metadata = { title: 'Users' };

export default async function UsersPage() {
  const { ctx } = await requireTenantPage();
  if (!can(ctx, 'user:list')) redirect('/app/dashboard');
  return (
    <>
      <PageHeader title="Users" description="Your team, their roles and what they own." />
      <UsersTable currentUserId={ctx.userId} />
    </>
  );
}
