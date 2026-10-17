'use client';

import { RefreshCw, ScrollText } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { formatDateTime, formatRelative } from '@/lib/format';

import { RUN_STATUS, type Rule, type Run, type RunStatus } from './types';

const STATUSES: RunStatus[] = ['DONE', 'SKIPPED', 'FAILED', 'PENDING', 'RUNNING'];

/** Every time a rule ran: what happened, who it was about, and what each action did. */
export function RunLog({
  rules,
  ruleId,
  onRuleChange,
}: {
  rules: Rule[];
  ruleId: string;
  onRuleChange: (id: string) => void;
}) {
  const api = useApi();
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (after?: string) => {
      const qs = new URLSearchParams({ limit: '30' });
      if (ruleId) qs.set('ruleId', ruleId);
      if (status) qs.set('status', status);
      if (after) qs.set('cursor', after);
      const res = await api<Run[]>(`/api/automations/runs?${qs}`);
      if (!res.ok) return setError(res.error.message);
      setError(null);
      setItems((prev) => (after && prev ? [...prev, ...res.data] : res.data));
      setCursor((res.meta?.['nextCursor'] as string | null) ?? null);
    },
    [api, ruleId, status],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field id="runs-rule" label="Rule" className="sm:w-72">
          <Select id="runs-rule" value={ruleId} onChange={(e) => onRuleChange(e.target.value)}>
            <option value="">All rules</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="runs-status" label="Result" className="sm:w-48">
          <Select id="runs-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any result</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {RUN_STATUS[s].label}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" loading={refreshing} onClick={() => void refresh()}>
          <RefreshCw /> Refresh
        </Button>
      </div>

      <Card>
        {error ? (
          <div className="p-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : !items ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ScrollText />}
            title="No runs yet"
            description="When a rule fires, what it did is recorded here. Runs are kept for 90 days."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((run) => {
              const st = RUN_STATUS[run.status];
              return (
                <li key={run.id} className="space-y-1.5 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{run.ruleName}</span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    <span className="text-xs text-muted-foreground" title={formatDateTime(run.createdAt)}>
                      {formatRelative(run.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm">
                    {run.subject && (
                      <>
                        {run.leadId ? (
                          <Link
                            href={`/app/leads/${run.leadId}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {run.subject}
                          </Link>
                        ) : run.webLeadId ? (
                          <Link
                            href="/app/web-leads?status="
                            className="font-medium text-primary hover:underline"
                          >
                            {run.subject}
                          </Link>
                        ) : (
                          <span className="font-medium">{run.subject}</span>
                        )}
                        {run.summary ? ' · ' : ''}
                      </>
                    )}
                    {run.summary && <span className="text-muted-foreground">{run.summary}</span>}
                  </p>
                  {run.actions.length > 0 && (
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      {run.actions.map((a, i) => (
                        <li key={i}>
                          {a.outcome === 'done' ? '✓' : '–'} {a.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                  {run.status === 'FAILED' && run.attempts > 1 && (
                    <p className="text-xs text-muted-foreground">Tried {run.attempts} times.</p>
                  )}
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
