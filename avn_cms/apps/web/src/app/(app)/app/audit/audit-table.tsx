'use client';

import { ScrollText } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDateTime } from '@/lib/format';

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
  { id: 'web_lead.', label: 'Web leads' },
  { id: 'intake_credential.', label: 'Integrations' },
  { id: 'settings.', label: 'Settings' },
  { id: 'impersonation.', label: 'Impersonation' },
];

function summarize(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
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
          <div className="overflow-x-auto">
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
                          <Badge tone="warning">impersonated</Badge>
                        </div>
                      )}
                      {r.ip && <div className="text-xs text-muted-foreground">{r.ip}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <code className="text-xs">{r.action}</code>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {r.entityType}
                      {r.entityId && <div className="break-all">{r.entityId}</div>}
                    </td>
                    <td className="max-w-md px-4 py-2.5 text-xs">
                      {r.oldValue !== null && r.oldValue !== undefined && (
                        <div className="break-all text-muted-foreground line-through decoration-muted-foreground/50">
                          {summarize(r.oldValue)}
                        </div>
                      )}
                      {r.newValue !== null && r.newValue !== undefined && (
                        <div className="break-all">{summarize(r.newValue)}</div>
                      )}
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
