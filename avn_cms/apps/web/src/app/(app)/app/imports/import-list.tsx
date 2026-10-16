'use client';

import { Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { Alert, Badge, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDateTime } from '@/lib/format';

import { STATUS, type ImportListItem } from './types';

function summaryOf(item: ImportListItem): string {
  const r = item.result;
  if (item.status === 'DONE') {
    return `${r.created ?? 0} created · ${r.updated ?? 0} updated · ${r.failed ?? 0} failed`;
  }
  if (item.status === 'VALIDATED') return `${r.valid ?? 0} ready · ${r.invalid ?? 0} with problems`;
  if (item.status === 'FAILED') {
    if (r.failedIn === 'run')
      return r.processed
        ? `Stopped after ${r.processed.toLocaleString('en-IN')} ${r.processed === 1 ? 'row' : 'rows'} · ${r.created ?? 0} created`
        : 'Stopped before it finished';
    return r.error ?? 'Failed';
  }
  return '—';
}

export function ImportList() {
  const api = useApi();
  const [items, setItems] = useState<ImportListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api<ImportListItem[]>('/api/imports', { signal: ctrl.signal })
      .then((res) => {
        if (res.ok) setItems(res.data);
        else setError(res.error.message);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [api]);

  if (error)
    return (
      <Alert tone="danger" title="Couldn’t load imports">
        {error}
      </Alert>
    );
  if (!items) return <Skeleton className="h-40 w-full" />;
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Upload />}
          title="No imports yet"
          description="Upload a CSV or Excel file to add many students at once."
          action={
            <Link href="/app/imports/new" className={buttonVariants()}>
              Start an import
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Imports, newest first</caption>
          <thead className="bg-surface text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-2.5">
                File
              </th>
              <th scope="col" className="px-4 py-2.5">
                Status
              </th>
              <th scope="col" className="px-4 py-2.5">
                Rows
              </th>
              <th scope="col" className="px-4 py-2.5">
                Result
              </th>
              <th scope="col" className="px-4 py-2.5">
                Started
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const status = STATUS[item.status] ?? { label: item.status, tone: 'neutral' as const };
              return (
                <tr key={item.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`/app/imports/${item.id}`}
                      className="font-medium text-foreground hover:text-primary"
                    >
                      {item.filename}
                    </Link>
                    <div className="text-xs text-muted-foreground">by {item.requestedBy}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{item.rowCount.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-muted-foreground">{summaryOf(item)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {formatDateTime(item.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
