import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/primitives';
import { requireTenantPage } from '@/lib/session';

import { NotificationsList } from './notifications-list';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
  await requireTenantPage();
  return (
    <>
      <PageHeader
        title="Notifications"
        description="What the system told you: leads routed to you, calls to chase and escalations. Only you see yours."
      />
      <NotificationsList />
    </>
  );
}
