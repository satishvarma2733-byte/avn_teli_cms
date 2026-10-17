import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { requireTenantPage } from '@/lib/session';

import { AutomationsView } from './automations-view';

export const metadata: Metadata = { title: 'Automations' };

export default async function AutomationsPage() {
  const { ctx } = await requireTenantPage();
  if (!can(ctx, 'automation:manage')) redirect('/app/dashboard');
  return <AutomationsView />;
}
