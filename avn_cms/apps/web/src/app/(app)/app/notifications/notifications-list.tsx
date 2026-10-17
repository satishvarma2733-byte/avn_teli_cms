'use client';

import { Bell, CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { NOTIFICATIONS_CHANGED } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';
import { formatDateTime, formatRelative } from '@/lib/format';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Where a notification leads, when it is about a record the person can open. */
function target(n: Notification): { href: string; label: string } | null {
  if (n.entityType === 'lead' && n.entityId) return { href: `/app/leads/${n.entityId}`, label: 'Open lead' };
  if (n.entityType === 'web_lead') return { href: '/app/web-leads', label: 'Open web leads' };
  return null;
}

export function NotificationsList() {
  const api = useApi();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (after?: string) => {
      const qs = new URLSearchParams({ limit: '30', unreadOnly: String(unreadOnly) });
      if (after) qs.set('cursor', after);
      const res = await api<Notification[]>(`/api/notifications?${qs}`);
      if (!res.ok) return setError(res.error.message);
      setError(null);
      setItems((prev) => (after && prev ? [...prev, ...res.data] : res.data));
      setCursor((res.meta?.['nextCursor'] as string | null) ?? null);
      setUnread((res.meta?.['unread'] as number | undefined) ?? 0);
    },
    [api, unreadOnly],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  async function markRead(body: { ids: string[] } | { all: true }) {
    setBusy(true);
    const res = await api<{ marked: number; unread: number }>('/api/notifications/read', { body });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setUnread(res.data.unread);
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
    void load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="group" aria-label="Show">
          {[
            { id: false, label: 'All' },
            { id: true, label: 'Unread' },
          ].map((t) => (
            <button
              key={t.label}
              type="button"
              aria-pressed={unreadOnly === t.id}
              onClick={() => setUnreadOnly(t.id)}
              className={cn(
                'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium',
                unreadOnly === t.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
              )}
            >
              {t.label}
              {t.id && unread > 0 && (
                <span className="rounded-full bg-surface-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                  {unread}
                </span>
              )}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={unread === 0}
          loading={busy}
          onClick={() => void markRead({ all: true })}
        >
          <CheckCheck /> Mark all as read
        </Button>
      </div>

      {error && (
        <Alert tone="danger" title="Couldn’t load notifications">
          {error}
        </Alert>
      )}

      <Card>
        {!items ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
            description="When a rule routes a lead to you or a call needs chasing, you will see it here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((n) => {
              const go = target(n);
              return (
                <li key={n.id} className="flex items-start gap-3 px-4 py-4">
                  <span
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      n.readAt ? 'bg-transparent' : 'bg-primary',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className={cn('text-sm', n.readAt ? 'text-foreground' : 'font-semibold')}>
                      {!n.readAt && <span className="sr-only">Unread: </span>}
                      {n.title}
                    </p>
                    {n.body && <p className="text-sm text-muted-foreground">{n.body}</p>}
                    <p className="text-xs text-muted-foreground">
                      <span title={formatDateTime(n.createdAt)}>{formatRelative(n.createdAt)}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {go && (
                      <Link
                        href={go.href}
                        onClick={() => {
                          if (!n.readAt) void markRead({ ids: [n.id] });
                        }}
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        {go.label} →
                      </Link>
                    )}
                    {!n.readAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void markRead({ ids: [n.id] })}
                        aria-label={`Mark read: ${n.title}`}
                      >
                        Mark read
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <Button size="sm" variant="secondary" onClick={() => void load(cursor)}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
