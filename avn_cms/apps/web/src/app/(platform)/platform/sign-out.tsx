'use client';

import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/client';

export function PlatformSignOut() {
  const api = useApi();
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        await api('/api/auth/logout', { method: 'POST' });
        window.location.assign('/login');
      }}
    >
      Sign out
    </Button>
  );
}
