import { platform } from '@avn-cms/core';
import type { Metadata } from 'next';

import { PageHeader, StatCard } from '@/components/ui/primitives';
import { requirePlatformPage } from '@/lib/session';

import { TenantsPanel } from './tenants-panel';

export const metadata: Metadata = { title: 'Platform' };

export default async function PlatformPage() {
  const principal = await requirePlatformPage();
  const m = await platform.platformMetrics(principal);
  const tenants = await platform.listTenants(principal);
  return (
    <>
      <PageHeader
        title="Platform"
        description="Agencies on aVn CMS. Totals only — opening an agency's data requires audited impersonation."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Agencies" value={m.tenants} />
        <StatCard label="Active" value={m.activeTenants} />
        <StatCard label="Users" value={m.users} />
        <StatCard label="Leads" value={m.leads.toLocaleString('en-IN')} />
        <StatCard label="Web leads (30 days)" value={m.webLeads30d.toLocaleString('en-IN')} />
      </div>
      <div className="mt-6">
        <TenantsPanel initial={JSON.parse(JSON.stringify(tenants))} />
      </div>
    </>
  );
}
