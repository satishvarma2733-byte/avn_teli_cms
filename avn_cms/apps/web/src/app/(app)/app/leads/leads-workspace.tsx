'use client';

import { LEAD_STAGES, STAGE_LABEL, type LEAD_VIEWS } from '@avn-cms/core/schemas';
import type { LeadStage } from '@avn-cms/db/enums';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, Inbox, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LeadFlags, StageBadge } from '@/components/leads/stage-badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';
import { formatDate, formatDateTime, formatPhone } from '@/lib/format';
import { useDirectory } from '@/lib/use-directory';

interface Row {
  id: string;
  stage: LeadStage;
  isPotential: boolean;
  priority: 'NORMAL' | 'HOT';
  interestCountry: string | null;
  nextCallAt: string | null;
  createdAt: string;
  student: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    town: string | null;
    state: string | null;
  };
  source: { label: string };
  counselor: { id: string; name: string } | null;
  telecaller: { id: string; name: string } | null;
}

type View = (typeof LEAD_VIEWS)[number];
const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'today', label: 'Calls today' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'potential', label: 'Potential' },
  { id: 'hot', label: 'HOT' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'closed', label: 'Closed' },
];

const FILTER_KEYS = [
  'view',
  'q',
  'stage',
  'sourceId',
  'counselorId',
  'telecallerId',
  'state',
  'sort',
] as const;

export function LeadsWorkspace({
  role,
  canBulk,
  canFilterByAssignee,
}: {
  role: string;
  canBulk: boolean;
  canFilterByAssignee: boolean;
}) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(
    () => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])),
    [params],
  );
  const view = (filters['view'] || 'all') as View;

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState(filters['q'] ?? '');
  const [bulkOpen, setBulkOpen] = useState(false);

  const sources = useDirectory('sources');
  const counselors = useDirectory('counselors', canFilterByAssignee);
  const telecallers = useDirectory('telecallers', canFilterByAssignee);

  const setParam = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  // Debounced search box → URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== (filters['q'] ?? '')) setParam({ q: search.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [search, filters, setParam]);

  const queryString = useMemo(() => {
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (filters[k]) qs.set(k, filters[k]!);
    qs.set('limit', '50');
    return qs.toString();
  }, [filters]);

  const load = useCallback(
    async (after?: string) => {
      const res = await api<Row[]>(
        `/api/students?${queryString}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`,
      );
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      setError(null);
      setRows((prev) => (after ? [...prev, ...res.data] : res.data));
      setCursor((res.meta?.['nextCursor'] as string | null) ?? null);
      if (!after) setTotal((res.meta?.['total'] as number | undefined) ?? null);
    },
    [api, queryString],
  );

  useEffect(() => {
    setLoading(true);
    setSelected(new Set());
    load().finally(() => setLoading(false));
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    await load(cursor);
    setLoadingMore(false);
  }

  const listRef = useRef<HTMLTableSectionElement>(null);
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 61,
    overscan: 10,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });
  const items = virtualizer.getVirtualItems();
  const padTop = items.length ? items[0]!.start - virtualizer.options.scrollMargin : 0;
  const padBottom = items.length ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const activeFilterCount = ['stage', 'sourceId', 'counselorId', 'telecallerId', 'state'].filter(
    (k) => filters[k],
  ).length;
  const showTelecaller = role !== 'TELECALLER';

  return (
    <div className="space-y-4">
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Saved views">
        {VIEWS.filter(
          (v) =>
            !(v.id === 'mine' && role !== 'TENANT_ADMIN') &&
            !(v.id === 'unassigned' && role !== 'TENANT_ADMIN'),
        ).map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setParam({ view: v.id === 'all' ? '' : v.id })}
            className={cn(
              'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              view === v.id
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <Card>
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                aria-label="Search leads"
                placeholder="Search by name, parent, phone or email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              aria-label="Sort"
              value={filters['sort'] || 'newest'}
              onChange={(e) => setParam({ sort: e.target.value === 'newest' ? '' : e.target.value })}
              className="w-40 shrink-0 sm:w-44"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="updated">Recently updated</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Select
              aria-label="Stage"
              value={filters['stage']}
              onChange={(e) => setParam({ stage: e.target.value })}
              className="sm:w-44"
            >
              <option value="">All stages</option>
              {LEAD_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Source"
              value={filters['sourceId']}
              onChange={(e) => setParam({ sourceId: e.target.value })}
              className="sm:w-40"
            >
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
            {canFilterByAssignee && (
              <>
                <Select
                  aria-label="Counselor"
                  value={filters['counselorId']}
                  onChange={(e) => setParam({ counselorId: e.target.value })}
                  className="sm:w-44"
                >
                  <option value="">Any counselor</option>
                  {counselors.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Telecaller"
                  value={filters['telecallerId']}
                  onChange={(e) => setParam({ telecallerId: e.target.value })}
                  className="sm:w-44"
                >
                  <option value="">Any telecaller</option>
                  {telecallers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </>
            )}
            {activeFilterCount > 0 && (
              <Button
                variant="ghost"
                onClick={() =>
                  setParam({ stage: '', sourceId: '', counselorId: '', telecallerId: '', state: '' })
                }
              >
                <X /> Clear ({activeFilterCount})
              </Button>
            )}
          </div>
        </div>

        {canBulk && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-border bg-primary-soft px-4 py-2 text-sm">
            <span className="font-medium text-primary">{selected.size} selected</span>
            <Button size="sm" onClick={() => setBulkOpen(true)}>
              Bulk actions
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {error ? (
          <div className="p-4">
            <Alert tone="danger" title="Couldn't load leads">
              {error}{' '}
              <button className="font-medium underline" onClick={() => load()}>
                Try again
              </button>
            </Alert>
          </div>
        ) : loading ? (
          <div className="space-y-3 p-4" role="status" aria-busy="true" aria-label="Loading leads">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title="No leads match"
            description={
              filters['q'] || activeFilterCount
                ? 'Try a different search or clear the filters.'
                : 'New enquiries will appear here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="sticky top-0 z-10 bg-surface text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  {canBulk && (
                    <th className="w-10 px-4 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Select all loaded leads"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="size-4 accent-[var(--primary)]"
                      />
                    </th>
                  )}
                  <th className="px-4 py-2.5">Student</th>
                  <th className="px-4 py-2.5">Stage</th>
                  <th className="hidden px-4 py-2.5 lg:table-cell">Source</th>
                  <th className="hidden px-4 py-2.5 md:table-cell">Counselor</th>
                  {showTelecaller && <th className="hidden px-4 py-2.5 xl:table-cell">Telecaller</th>}
                  <th className="whitespace-nowrap px-4 py-2.5">Next call</th>
                  <th className="hidden px-4 py-2.5 xl:table-cell">Added</th>
                </tr>
              </thead>
              <tbody ref={listRef}>
                {padTop > 0 && (
                  <tr aria-hidden>
                    <td style={{ height: padTop }} />
                  </tr>
                )}
                {items.map((vi) => {
                  const r = rows[vi.index]!;
                  const overdue = r.nextCallAt && new Date(r.nextCallAt).getTime() < Date.now();
                  return (
                    <tr
                      key={r.id}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className="border-b border-border last:border-0 hover:bg-surface-muted/60"
                    >
                      {canBulk && (
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.student.name}`}
                            checked={selected.has(r.id)}
                            onChange={() => toggle(r.id)}
                            className="size-4 accent-[var(--primary)]"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <Link
                          href={`/app/leads/${r.id}`}
                          className="whitespace-nowrap font-medium text-foreground hover:text-primary"
                        >
                          {r.student.name}
                        </Link>
                        <div className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                          {formatPhone(r.student.phone)}
                          {r.student.town ? ` · ${r.student.town}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <StageBadge stage={r.stage} />
                          <LeadFlags isPotential={r.isPotential} priority={r.priority} />
                        </div>
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-3 text-muted-foreground lg:table-cell">
                        {r.source.label}
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-3 md:table-cell">
                        {r.counselor?.name ?? <span className="text-muted-foreground">Unassigned</span>}
                      </td>
                      {showTelecaller && (
                        <td className="hidden whitespace-nowrap px-4 py-3 xl:table-cell">
                          {r.telecaller?.name ?? <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                      <td
                        className={cn(
                          'whitespace-nowrap px-4 py-3 tabular-nums',
                          overdue ? 'text-danger' : 'text-muted-foreground',
                        )}
                      >
                        {overdue && (
                          <AlertCircle className="mr-1 inline size-3.5 align-[-2px]" aria-label="Overdue" />
                        )}
                        {formatDateTime(r.nextCallAt)}
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-3 text-muted-foreground xl:table-cell">
                        {formatDate(r.createdAt)}
                      </td>
                    </tr>
                  );
                })}
                {padBottom > 0 && (
                  <tr aria-hidden>
                    <td style={{ height: padBottom }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm text-muted-foreground">
            <span>
              Showing {rows.length.toLocaleString('en-IN')}
              {total !== null ? ` of ${total.toLocaleString('en-IN')}` : ''}
            </span>
            {cursor && (
              <Button variant="secondary" size="sm" onClick={loadMore} loading={loadingMore}>
                Load more
              </Button>
            )}
          </div>
        )}
      </Card>

      {canBulk && (
        <BulkDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          ids={[...selected]}
          counselors={counselors}
          telecallers={telecallers}
          onDone={() => {
            setBulkOpen(false);
            setSelected(new Set());
            load();
          }}
        />
      )}
    </div>
  );
}

function BulkDialog({
  open,
  onOpenChange,
  ids,
  counselors,
  telecallers,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ids: string[];
  counselors: { id: string; name?: string }[];
  telecallers: { id: string; name?: string }[];
  onDone: () => void;
}) {
  const api = useApi();
  const [action, setAction] = useState<'reassign' | 'setStage' | 'block'>('reassign');
  const [counselorId, setCounselorId] = useState('');
  const [telecallerId, setTelecallerId] = useState('');
  const [stage, setStage] = useState<LeadStage>('CONTACTED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const body =
      action === 'reassign'
        ? { action, ids, ...(counselorId ? { counselorId } : {}), ...(telecallerId ? { telecallerId } : {}) }
        : action === 'setStage'
          ? { action, ids, stage, note }
          : { action, ids, note };
    const res = await api<{ changed: number; found: number }>('/api/students/bulk', { body });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setResult(`${res.data.changed} of ${res.data.found} leads updated.`);
    setTimeout(onDone, 900);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setResult(null);
          setError(null);
        }
      }}
      title={`Bulk update ${ids.length} lead${ids.length === 1 ? '' : 's'}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={busy}
            disabled={action === 'reassign' && !counselorId && !telecallerId}
            variant={action === 'block' ? 'danger' : 'primary'}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {result && <Alert tone="success">{result}</Alert>}
        <Field id="bulk-action" label="Action">
          <Select
            id="bulk-action"
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
          >
            <option value="reassign">Reassign</option>
            <option value="setStage">Set stage</option>
            <option value="block">Block</option>
          </Select>
        </Field>
        {action === 'reassign' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="bulk-counselor" label="Counselor">
              <Select
                id="bulk-counselor"
                value={counselorId}
                onChange={(e) => setCounselorId(e.target.value)}
              >
                <option value="">Keep current</option>
                {counselors.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="bulk-telecaller" label="Telecaller">
              <Select
                id="bulk-telecaller"
                value={telecallerId}
                onChange={(e) => setTelecallerId(e.target.value)}
              >
                <option value="">Keep current</option>
                {telecallers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {action === 'setStage' && (
          <Field id="bulk-stage" label="New stage">
            <Select id="bulk-stage" value={stage} onChange={(e) => setStage(e.target.value as LeadStage)}>
              {LEAD_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {action !== 'reassign' && (
          <Field id="bulk-note" label="Note" hint="Saved in each lead's history.">
            <Textarea id="bulk-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {action === 'block' && (
          <Alert tone="warning">Blocked leads move to the Blocked stage and leave the active queues.</Alert>
        )}
      </div>
    </Dialog>
  );
}
