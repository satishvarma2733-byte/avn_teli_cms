import { can, type Action, type PolicyCtx } from '@avn-cms/core/policy';

export type NavIcon =
  'dashboard' | 'leads' | 'followups' | 'webleads' | 'reports' | 'users' | 'audit' | 'settings' | 'account';

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

/** Navigation rendered from the same policy that gates the API (PAGES_AND_ROUTES cross-cutting UI). */
const ITEMS: (NavItem & { action: Action })[] = [
  { href: '/app/dashboard', label: 'Dashboard', icon: 'dashboard', action: 'followup:view' },
  { href: '/app/leads', label: 'Leads', icon: 'leads', action: 'student:list' },
  { href: '/app/followups', label: 'Follow-ups', icon: 'followups', action: 'followup:view' },
  { href: '/app/web-leads', label: 'Web leads', icon: 'webleads', action: 'webLead:view' },
  { href: '/app/reports', label: 'Reports', icon: 'reports', action: 'report:viewOwn' },
  { href: '/app/users', label: 'Users', icon: 'users', action: 'user:list' },
  { href: '/app/audit', label: 'Audit log', icon: 'audit', action: 'audit:view' },
  { href: '/app/settings', label: 'Settings', icon: 'settings', action: 'settings:manage' },
];

export function navFor(ctx: PolicyCtx): NavItem[] {
  const items: NavItem[] = ITEMS.filter((i) => {
    if (i.href === '/app/reports') return can(ctx, 'report:viewOwn') || can(ctx, 'report:viewTenant');
    return can(ctx, i.action);
  }).map(({ href, label, icon }) => ({ href, label, icon }));
  items.push({ href: '/app/account', label: 'My account', icon: 'account' });
  return items;
}
