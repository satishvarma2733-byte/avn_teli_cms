'use client';

import { ScrollText } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, Skeleton, scrollRegionProps } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDateTime } from '@/lib/format';

import { actionLabel, describeChanges, entityLabel, leadLink } from './describe';

interface Row {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValue: unknown;
  newValue: unknown;
  ip: string | null;
  createdAt: string;
  actorName: string;
  impersonatedBy: string | null;
}

const GROUPS = [
  { id: '', label: 'All actions' },
  { id: 'auth.', label: 'Sign-in & security' },
  { id: 'user.', label: 'Users & roles' },
  { id: 'student.', label: 'Students' },
  { id: 'lead.', label: 'Leads' },
  { id: 'followup.', label: 'Follow-ups' },
  { id: 'note.', label: 'Notes' },
  { id: 'document.', label: 'Documents' },
  { id: 'folder.', label: 'Folders' },
  { id: 'import.', label: 'Imports' },
  { id: 'export.', label: 'Exports' },
  { id: 'web_lead.', label: 'Web leads' },
  { id: 'automation.', label: 'Automations' },
  { id: 'intake_credential.', label: 'Website keys' },
  { id: 'source.', label: 'Lead sources' },
  { id: 'settings.', label: 'Settings' },
  { id: 'impersonation.', label: 'Support access' },
];

const hasValue = (v: unknown) => v !== null && v !== undefined;

function RecordLinks({ row, onFilter }: { row: Row; onFilter: (id: string) => void }) {
  const href = leadLink(row);
  if (!row.entityId && !href) return null;
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
      {href && (
        <Link href={href} className="text-primary hover:underline">
          Open student
        </Link>
      )}
      {row.entityId && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground hover:underline"
          title={row.entityId}
          onClick={() => onFilter(row.entityId!)}
        >
          Only this record
        </button>
      )}
    </div>
  );
}

function ChangeSummary({ row }: { row: Row }) {
  const lines = describeChanges(row.oldValue, row.newValue);
  const raw = hasValue(row.oldValue) || hasValue(row.newValue);
  if (!raw) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-1">
      {lines.length > 0 && (
        <ul className="space-y-0.5">
          {lines.map((l) => (
            <li key={l.field}>
              <span className="text-muted-foreground">{l.field}: </span>
              {l.from !== undefined && (
                <>
                  <span className="text-muted-foreground line-through decoration-muted-foreground/50">
                    {l.from}
                  </span>
                  {l.to !== undefined && <span aria-label="changed to"> → </span>}
                </>
              )}
              {l.to !== undefined && <span>{l.to}</span>}
            </li>
          ))}
        </ul>
      )}
      <details className="text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">Raw details</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-muted p-2 font-mono text-[11px]">
          {JSON.stringify({ before: row.oldValue ?? null, after: row.newValue ?? null }, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function AuditTable() {
  const api = useApi();
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (action) qs.set('action', action);
      if (entityId.trim()) qs.set('entityId', entityId.trim());
      if (after) qs.set('cursor', after);
      const res = await api<Row[]>(`/api/audit?${qs}`);
      if (!res.ok) return setError(res.error.message);
      setError(null);
      setRows((prev) => (after && prev ? [...prev, ...res.data] : res.data));
      setCursor((res.meta?.['nextCursor'] as string | null) ?? null);
    },
    [api, action, entityId],
  );
  useEffect(() => {
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label="Action type"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="w-56"
        >
          {GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Record id"
          placeholder="Filter by record id"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          className="w-80"
        />
        {entityId && (
          <Button size="sm" variant="ghost" onClick={() => setEntityId('')}>
            Show all records
          </Button>
        )}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        {!rows ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<ScrollText />} title="No matching entries" />
        ) : (
          <div {...scrollRegionProps('Audit log entries')}>
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Who</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Record</th>
                  <th className="px-4 py-2.5 font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">
                      {formatDateTime(r.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.actorName}
                      {r.impersonatedBy && (
                        <div>
                          <Badge tone="warning">Support access · {r.impersonatedBy}</Badge>
                        </div>
                      )}
                      {r.ip && <div className="text-xs text-muted-foreground">{r.ip}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{actionLabel(r.action)}</div>
                      <code className="text-xs text-muted-foreground">{r.action}</code>
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <div>{entityLabel(r.entityType)}</div>
                      <RecordLinks row={r} onFilter={setEntityId} />
                    </td>
                    <td className="max-w-md px-4 py-2.5 text-xs">
                      <ChangeSummary row={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <Button size="sm" variant="secondary" onClick={() => load(cursor)}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
