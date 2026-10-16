import type { ReactNode } from 'react';

import { Brand } from '@/components/brand';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Brand />
        </div>
        <div className="rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">{children}</div>
        <p className="mt-6 text-center text-xs text-muted-foreground">aVn CMS · Student admissions CRM</p>
      </div>
    </main>
  );
}
