import { AppError, leads } from '@avn-cms/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireTenantPage } from '@/lib/session';

import { LeadDetail } from './lead-detail';

export const metadata: Metadata = { title: 'Lead' };

export default async function LeadPage({ params, searchParams }: PageProps<'/app/leads/[leadId]'>) {
  const { ctx } = await requireTenantPage();
  const { leadId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) notFound();
  try {
    const lead = await leads.getLead(ctx, leadId);
    return (
      <LeadDetail initial={JSON.parse(JSON.stringify(lead))} emailWarning={sp['emailWarning'] === '1'} />
    );
  } catch (err) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
}
