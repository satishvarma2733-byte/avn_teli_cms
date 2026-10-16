import type { ReactNode } from 'react';

import { navFor } from '@/components/shell/nav';
import { AppShell } from '@/components/shell/app-shell';
import { CsrfProvider } from '@/lib/client';
import { requireTenantPage } from '@/lib/session';
import { tenantName } from '@/lib/tenant';

/** Authenticated tenant app: every page below requires a session and a tenant context. */
export default async function TenantAppLayout({ children }: { children: ReactNode }) {
  const { principal, ctx } = await requireTenantPage();
  return (
    <CsrfProvider token={principal.csrfToken}>
      <AppShell
        nav={navFor(ctx)}
        user={{ name: principal.name, email: principal.email, role: principal.role }}
        tenantName={principal.tenantName ?? (await tenantName(ctx.tenantId))}
        impersonating={Boolean(ctx.impersonatedBy)}
      >
        {children}
      </AppShell>
    </CsrfProvider>
  );
}
