import type { ReactNode } from 'react';

import { Brand } from '@/components/brand';
import { CsrfProvider } from '@/lib/client';
import { requirePlatformPage } from '@/lib/session';

import { PlatformSignOut } from './sign-out';

/** Super-admin area: separate tree, requires SUPER_ADMIN on every request. */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const principal = await requirePlatformPage();
  return (
    <CsrfProvider token={principal.csrfToken}>
      <header className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Brand />
            <span className="rounded-md bg-foreground px-2 py-0.5 text-xs font-medium text-background">
              Platform
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-muted-foreground sm:inline">{principal.email}</span>
            <PlatformSignOut />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </CsrfProvider>
  );
}
