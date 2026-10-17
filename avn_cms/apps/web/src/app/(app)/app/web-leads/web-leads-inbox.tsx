'use client';

import { Globe, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, Skeleton, type Tone } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';
import { formatDateTime, formatPhone, formatRelative } from '@/lib/format';
import { useDirectory } from '@/lib/use-directory';

type Status = 'NEW' | 'DUPLICATE' | 'CONVERTED' | 'SPAM' | 'REJECTED';

interface WebLead {
  id: string;
  name: string;
  phoneE164: string | null;
  email: string | null;
  interestCountry: string | null;
  message: string | null;
  sourceLabel: string | null;
  status: Status;
  submittedAt: string;
  dedupeMatchStudentId: string | null;
  convertedLeadId: string | null;
  intakeChannel: string;
  city: string | null;
  neetScore: number | null;
  utmSource: string | null;
  utmCampaign: string | null;
  gclid: string | null;
  postSlug: string | null;
  qualityFlags: string[];
  source: { id: string; label: string } | null;
  /** The counselor an automation rule (or an admin) sent this enquiry to. */
  routedToName: string | null;
}

const TABS: { id: Status | ''; label: string }[] = [
  { id: 'NEW', label: 'New' },
  { id: 'DUPLICATE', label: 'Duplicate' },
  { id: 'CONVERTED', label: 'Converted' },
  { id: 'SPAM', label: 'Spam' },
  { id: 'REJECTED', label: 'Rejected' },
  { id: '', label: 'All' },
];

const STATUS_TONE: Record<Status, Tone> = {
  NEW: 'info',
  DUPLICATE: 'warning',
  CONVERTED: 'success',
  SPAM: 'danger',
  REJECTED: 'neutral',
};
const FLAG_LABEL: Record<string, string> = {
  REPEAT_SUBMISSION: 'Repeat within 24h',
  INVALID_EMAIL: 'Invalid email',
  ROLE_EMAIL: 'Generic email (info@…)',
  INVALID_NEET_SCORE: 'Odd NEET score',
};

export function WebLeadsInbox({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const status = params.has('status') ? (params.get('status') as Status | '') : 'NEW';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [items, setItems] = useState<WebLead[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: React.ReactNode } | null>(null);
  const [converting, setConverting] = useState<WebLead | null>(null);

  const setParam = useCallback(
    (k: string, v: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (v === null) next.delete(k);
      else next.set(k, v);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  useEffect(() => {
    const t = setTimeout(() => {
      if (q !== (params.get('q') ?? '')) setParam('q', q.trim() || null);
    }, 300);
    return () => clearTimeout(t);
  }, [q, params, setParam]);

  const load = useCallback(
    async (after?: string) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (status) qs.set('status', status);
      const query = params.get('q');
      if (query) qs.set('q', query);
      if (after) qs.set('cursor', after);
      const res = await api<WebLead[]>(`/api/web-leads?${qs}`);
      if (!res.ok) return setError(res.error.message);
      setError(null);
      setItems((prev) => (after && prev ? [...prev, ...res.data] : res.data));
      setCursor((res.meta?.['nextCursor'] as string | null) ?? null);
      setCounts((res.meta?.['counts'] as Record<string, number>) ?? {});
    },
    [api, status, params],
  );

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  async function mark(item: WebLead, next: Status) {
    const res = await api(`/api/web-leads/${item.id}`, { method: 'PATCH', body: { status: next } });
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    setNotice({ tone: 'success', text: `${item.name} marked as ${next.toLowerCase()}.` });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Status">
          {TABS.map((t) => (
            <button
              key={t.label}
              role="tab"
              aria-selected={status === t.id}
              onClick={() => setParam('status', t.id === 'NEW' ? null : t.id)}
              className={cn(
                'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium',
                status === t.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
              )}
            >
              {t.label}
              {t.id && counts[t.id] !== undefined && (
                <span className="rounded-full bg-surface-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="relative sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            aria-label="Search web leads"
            placeholder="Name, phone or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card>
        {error ? (
          <div className="p-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : !items ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Globe />}
            title="No web leads here"
            description="Enquiries from connected websites land in this inbox."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((w) => (
              <li
                key={w.id}
                className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-start lg:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{w.name}</span>
                    <Badge tone={STATUS_TONE[w.status]}>{w.status.toLowerCase()}</Badge>
                    {w.qualityFlags.map((f) => (
                      <Badge key={f} tone="warning">
                        {FLAG_LABEL[f] ?? f}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <span className="tabular-nums text-foreground">{formatPhone(w.phoneE164)}</span>
                    {w.email ? ` · ${w.email}` : ''}
                    {w.city ? ` · ${w.city}` : ''}
                    {w.interestCountry ? ` · ${w.interestCountry}` : ''}
                    {w.neetScore !== null ? ` · NEET ${w.neetScore}` : ''}
                  </p>
                  {w.message && <p className="line-clamp-2 text-sm">“{w.message}”</p>}
                  <p className="text-xs text-muted-foreground">
                    <span title={formatDateTime(w.submittedAt)}>{formatRelative(w.submittedAt)}</span> ·{' '}
                    {w.source?.label ?? 'Website'}
                    {w.sourceLabel ? ` (${w.sourceLabel})` : ''}
                    {w.utmCampaign ? ` · campaign ${w.utmCampaign}` : ''}
                    {w.gclid ? ' · Google click' : ''}
                    {w.postSlug ? ` · blog: ${w.postSlug}` : ''}
                    {w.routedToName ? ` · routed to ${isAdmin ? w.routedToName : 'you'}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {w.status === 'CONVERTED' && w.convertedLeadId ? (
                    <Link
                      href={`/app/leads/${w.convertedLeadId}`}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      Open lead →
                    </Link>
                  ) : (
                    <>
                      <Button size="sm" onClick={() => setConverting(w)}>
                        {w.dedupeMatchStudentId ? 'Attach to student' : 'Convert'}
                      </Button>
                      {isAdmin && w.status !== 'SPAM' && (
                        <Button size="sm" variant="secondary" onClick={() => mark(w, 'SPAM')}>
                          Spam
                        </Button>
                      )}
                      {isAdmin && w.status !== 'REJECTED' && (
                        <Button size="sm" variant="ghost" onClick={() => mark(w, 'REJECTED')}>
                          Reject
                        </Button>
                      )}
                      {isAdmin && (w.status === 'SPAM' || w.status === 'REJECTED') && (
                        <Button size="sm" variant="ghost" onClick={() => mark(w, 'NEW')}>
                          Restore
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <Button size="sm" variant="secondary" onClick={() => load(cursor)}>
              Load more
            </Button>
          </div>
        )}
      </Card>

      {converting && (
        <ConvertDialog
          item={converting}
          isAdmin={isAdmin}
          onClose={() => setConverting(null)}
          onDone={(leadId, attached) => {
            setConverting(null);
            setNotice({
              tone: 'success',
              text: (
                <>
                  {attached ? 'Attached to the existing student. ' : 'Converted to a new lead. '}
                  <Link href={`/app/leads/${leadId}`} className="font-medium underline">
                    Open lead
                  </Link>
                </>
              ),
            });
            load();
          }}
        />
      )}
    </div>
  );
}

function ConvertDialog({
  item,
  isAdmin,
  onClose,
  onDone,
}: {
  item: WebLead;
  isAdmin: boolean;
  onClose: () => void;
  onDone: (leadId: string, attached: boolean) => void;
}) {
  const api = useApi();
  // Only admins choose who gets the lead; a counselor converting takes it themselves.
  const counselors = useDirectory('counselors', isAdmin);
  const telecallers = useDirectory('telecallers', isAdmin);
  const [counselorId, setCounselorId] = useState('');
  const [telecallerId, setTelecallerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await api<{ leadId: string; attachedToExisting: boolean }>(
      `/api/web-leads/${item.id}/convert`,
      {
        body: { ...(counselorId ? { counselorId } : {}), ...(telecallerId ? { telecallerId } : {}) },
      },
    );
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    onDone(res.data.leadId, res.data.attachedToExisting);
  }

  return (
    <Dialog
      open
      onOpenChange={onClose}
      title={
        item.dedupeMatchStudentId ? `Attach ${item.name} to the existing student` : `Convert ${item.name}`
      }
      description={
        item.dedupeMatchStudentId
          ? 'This phone number already belongs to a student. Their open lead gets a timeline entry; if all their leads are closed, a new lead is opened.'
          : 'Creates the student and a new lead with this enquiry’s source and message.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {item.dedupeMatchStudentId ? 'Attach' : 'Convert'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {isAdmin ? (
          <>
            <Field
              id="cv-counselor"
              label="Counselor"
              hint={
                item.routedToName
                  ? `Leave empty to give it to ${item.routedToName}, who it was routed to.`
                  : 'Leave empty to use round-robin, if it is switched on.'
              }
            >
              <Select id="cv-counselor" value={counselorId} onChange={(e) => setCounselorId(e.target.value)}>
                <option value="">Auto / keep current</option>
                {counselors.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="cv-telecaller" label="Telecaller">
              <Select
                id="cv-telecaller"
                value={telecallerId}
                onChange={(e) => setTelecallerId(e.target.value)}
              >
                <option value="">None</option>
                {telecallers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">The new lead will be assigned to you.</p>
        )}
      </div>
    </Dialog>
  );
}
