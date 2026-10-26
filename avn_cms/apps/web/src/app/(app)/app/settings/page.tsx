import { tenantSettings, usage } from '@avn-cms/core';
import { can } from '@avn-cms/core/policy';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { SettingsForm } from './settings-form';
import { UsageCard } from './usage-card';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const { ctx } = await requireTenantPage();
  if (!can(ctx, 'settings:manage')) redirect('/app/dashboard');
  const [settings, planUsage] = await Promise.all([tenantSettings.getSettings(ctx), usage.getUsage(ctx)]);
  return (
    <>
      <PageHeader
        title="Settings"
        description={`${settings.name} · workspace “${settings.slug}”${settings.plan ? ` · ${settings.plan.name} plan` : ''}`}
        actions={
          <Link
            href="/app/settings/integrations"
            className="text-sm font-medium text-primary hover:underline"
          >
            Website integrations →
          </Link>
        }
      />
      <UsageCard data={planUsage} />
      <SettingsForm initial={JSON.parse(JSON.stringify(settings))} />
    </>
  );
}
