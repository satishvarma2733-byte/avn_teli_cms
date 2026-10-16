'use client';

import type { CallDisposition, LeadStage } from '@avn-cms/db/enums';
import { CalendarClock, Phone, PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { DispositionBadge, LeadFlags, StageBadge } from '@/components/leads/stage-badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';
import { formatDateTime, formatPhone, formatRelative, fromLocalInput, toLocalInput } from '@/lib/format';
import { useDirectory } from '@/lib/use-directory';

import { LogCallDialog } from '../leads/[leadId]/lead-dialogs';

interface QueueItem {
  id: string;
  scheduledAt: string;
  disposition: CallDisposition;
  priority: 'NORMAL' | 'HOT';
  outcomeNote: string | null;
  completedAt: string | null;
  isOverdue: boolean;
  escalatedAt: string | null;
  assigneeName: string | null;
  lead: {
    id: string;
    stage: LeadStage;
    isPotential: boolean;
    priority: 'NORMAL' | 'HOT';
    interestCountry: string | null;
    student: { name: string; phoneE164: string; town: string | null };
  };
}

const BUCKETS = [
  { id: 'today', label: 'Today' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'pending', label: 'All open' },
  { id: 'closed', label: 'Closed' },
] as const;
type Bucket = (typeof BUCKETS)[number]['id'];

export function FollowupQueue({
  showAssignee,
  canChangeStage,
}: {
  showAssignee: boolean;
  canChangeStage: boolean;
}) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const bucket = (params.get('bucket') as Bucket) || 'today';
  const assigneeId = params.get('assigneeId') ?? '';
  const telecallers = useDirectory('telecallers', showAssignee);
  const counselors = useDirectory('counselors', showAssignee);

  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<QueueItem | null>(null);
  const [rescheduleFor, setRescheduleFor] = useState<QueueItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v);
    else next.delete(k);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const load = useCallback(
    async (after?: string) => {
      const qs = new URLSearchParams({ bucket, limit: '50' });
      if (assigneeId) qs.set('assigneeId', assigneeId);
      if (after) qs.set('cursor', after);
      const [res, c] = await Promise.all([
        api<QueueItem[]>(`/api/followups?${qs}`),
        after
          ? Promise.resolve(null)
          : api<Record<string, number>>(
              `/api/followups?counts=1${assigneeId ? `&assigneeId=${assigneeId}` : ''}`,
            ),
      ]);
      if (!res.ok) return setError(res.error.message);
      setError(null);
      setItems((prev) => (after && prev ? [...prev, ...res.data] : res.data));
      setCursor((res.meta?.['nextCursor'] as string | null) ?? null);
      if (c?.ok) setCounts(c.data);
    },
    [api, bucket, assigneeId],
  );

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  const team = [...counselors, ...telecallers.filter((t) => !counselors.some((c) => c.id === t.id))];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Queue">
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              role="tab"
              aria-selected={bucket === b.id}
              onClick={() => setParam('bucket', b.id === 'today' ? '' : b.id)}
              className={cn(
                'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium',
                bucket === b.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
              )}
            >
              {b.label}
              {counts[b.id] !== undefined && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-xs tabular-nums',
                    b.id === 'overdue' && counts[b.id]! > 0
                      ? 'bg-danger text-white'
                      : bucket === b.id
                        ? 'bg-background/20'
                        : 'bg-surface-muted',
                  )}
                >
                  {counts[b.id]}
                </span>
              )}
            </button>
          ))}
        </div>
        {showAssignee && (
          <Select
            aria-label="Caller"
            value={assigneeId}
            onChange={(e) => setParam('assigneeId', e.target.value)}
            className="sm:w-56"
          >
            <option value="">Everyone</option>
            {team.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        {error ? (
          <div className="p-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : !items ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<PhoneCall />}
            title={
              bucket === 'overdue'
                ? 'Nothing overdue'
                : bucket === 'closed'
                  ? 'No logged calls yet'
                  : 'No calls here'
            }
            description={bucket === 'today' ? 'Calls scheduled for today appear here.' : undefined}
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((f) => {
              const overdue = !f.completedAt && new Date(f.scheduledAt).getTime() < Date.now();
              return (
                <li
                  key={f.id}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/app/leads/${f.lead.id}`} className="font-medium hover:text-primary">
                        {f.lead.student.name}
                      </Link>
                      <StageBadge stage={f.lead.stage} />
                      <LeadFlags isPotential={f.lead.isPotential} priority={f.priority} />
                      {f.escalatedAt && <Badge tone="danger">Escalated</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      <a
                        href={`tel:${f.lead.student.phoneE164}`}
                        className="inline-flex items-center gap-1 tabular-nums text-foreground hover:text-primary"
                      >
                        <Phone className="size-3.5" /> {formatPhone(f.lead.student.phoneE164)}
                      </a>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 tabular-nums',
                          overdue && 'text-danger',
                        )}
                      >
                        <CalendarClock className="size-3.5" />
                        {formatDateTime(f.scheduledAt)} · {formatRelative(f.scheduledAt)}
                      </span>
                      {showAssignee && <span>{f.assigneeName}</span>}
                      {f.completedAt && <DispositionBadge disposition={f.disposition} />}
                      {f.outcomeNote && <span className="truncate">“{f.outcomeNote}”</span>}
                    </div>
                  </div>
                  {!f.completedAt && (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setRescheduleFor(f)}>
                        Reschedule
                      </Button>
                      <Button size="sm" onClick={() => setLogFor(f)}>
                        Log outcome
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <Button variant="secondary" size="sm" onClick={() => load(cursor)}>
              Load more
            </Button>
          </div>
        )}
      </Card>

      {logFor && (
        <LogCallDialog
          followUpId={logFor.id}
          currentStage={logFor.lead.stage}
          canChangeStage={canChangeStage}
          open
          onOpenChange={() => setLogFor(null)}
          onSaved={() => {
            setNotice(`Outcome saved for ${logFor.lead.student.name}.`);
            load();
          }}
        />
      )}
      {rescheduleFor && (
        <RescheduleDialog
          item={rescheduleFor}
          onClose={() => setRescheduleFor(null)}
          onSaved={() => {
            setNotice(`Call with ${rescheduleFor.lead.student.name} rescheduled.`);
            setRescheduleFor(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function RescheduleDialog({
  item,
  onClose,
  onSaved,
}: {
  item: QueueItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const [when, setWhen] = useState(() =>
    toLocalInput(new Date(Math.max(Date.now() + 3_600_000, new Date(item.scheduledAt).getTime()))),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    const res = await api(`/api/followups/${item.id}`, {
      method: 'PATCH',
      body: { scheduledAt: fromLocalInput(when) },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    onSaved();
  }
  return (
    <Dialog
      open
      onOpenChange={onClose}
      size="sm"
      title={`Reschedule call with ${item.lead.student.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <Field id="resched" label="New date and time">
        <Input id="resched" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
    </Dialog>
  );
}
