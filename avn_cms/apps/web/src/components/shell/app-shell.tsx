'use client';

import {
  Bell,
  BarChart3,
  ClipboardList,
  Download,
  FolderOpen,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  PhoneCall,
  ScrollText,
  Settings,
  ShieldAlert,
  Upload,
  UserCircle,
  Users,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';

import type { NavIcon, NavItem } from './nav';

const ICONS: Record<NavIcon, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  leads: ClipboardList,
  followups: PhoneCall,
  webleads: Globe,
  reports: BarChart3,
  imports: Upload,
  exports: Download,
  documents: FolderOpen,
  automations: Zap,
  notifications: Bell,
  users: Users,
  audit: ScrollText,
  settings: Settings,
  account: UserCircle,
};

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  TENANT_ADMIN: 'Tenant Admin',
  COUNSELOR: 'Counselor',
  TELECALLER: 'Telecaller',
};

/** Event the notifications page fires after it marks things read, so the badge updates at once. */
export const NOTIFICATIONS_CHANGED = 'avn:notifications-changed';

/** How many notifications are unread: checked on each page, every minute, and when the inbox changes. */
function useUnreadNotifications(pathname: string): number {
  const api = useApi();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let live = true;
    const check = () =>
      api<{ unread: number }>('/api/notifications/unread')
        .then((res) => {
          if (live && res.ok) setUnread(res.data.unread);
        })
        .catch(() => undefined);
    void check();
    const timer = setInterval(check, 60_000);
    window.addEventListener(NOTIFICATIONS_CHANGED, check);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, check);
    };
  }, [api, pathname]);
  return unread;
}

export function AppShell({
  nav,
  user,
  tenantName,
  impersonating,
  children,
}: {
  nav: NavItem[];
  user: { name: string; email: string; role: string };
  tenantName: string;
  impersonating: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const api = useApi();
  const unread = useUnreadNotifications(pathname);

  useEffect(() => setOpen(false), [pathname]);

  async function signOut() {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  }

  async function stopImpersonating() {
    await api('/api/platform/impersonation', { method: 'DELETE' });
    window.location.assign('/platform');
  }

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="flex h-16 items-center px-5">
        <Link href="/app/dashboard">
          <Brand />
        </Link>
      </div>
      <div className="px-3 pb-2">
        <div className="rounded-lg border border-border bg-surface-muted px-3 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Workspace</p>
          <p className="truncate text-sm font-medium" title={tenantName}>
            {tenantName}
          </p>
        </div>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {nav.map((item) => {
          const Icon = ICONS[item.icon];
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary-soft text-primary'
                    : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {item.label}
                {item.icon === 'notifications' && unread > 0 && (
                  <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums text-primary-foreground">
                    {unread > 99 ? '99+' : unread}
                    <span className="sr-only"> unread</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <span
            className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary"
            aria-hidden
          >
            {user.name
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{ROLE_LABEL[user.role] ?? user.role}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut />
          </Button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-sidebar lg:block">
        {sidebar}
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85%] border-r border-border bg-sidebar shadow-xl">
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-3"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
            >
              <X />
            </Button>
            {sidebar}
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur lg:hidden">
        <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu />
        </Button>
        <Brand />
      </header>

      {impersonating && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-center gap-3 bg-warning-soft px-4 py-2 text-sm text-warning"
        >
          <ShieldAlert className="size-4" aria-hidden />
          <span>
            You are acting as <strong>{tenantName}</strong>. Every action is audited.
          </span>
          <Button size="sm" variant="secondary" onClick={stopImpersonating}>
            Stop
          </Button>
        </div>
      )}

      <main id="main" className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {children}
      </main>
    </div>
  );
}
