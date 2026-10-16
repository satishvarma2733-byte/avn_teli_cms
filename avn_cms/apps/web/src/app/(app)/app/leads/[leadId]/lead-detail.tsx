'use client';

import { STAGE_LABEL } from '@avn-cms/core/schemas';
import * as Tabs from '@radix-ui/react-tabs';
import {
  ArrowLeft,
  CalendarPlus,
  Flame,
  Mail,
  MessageSquarePlus,
  Pencil,
  Phone,
  PhoneCall,
  Star,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { StudentDocuments } from '@/components/documents/student-documents';
import { DispositionBadge, LeadFlags, StageBadge } from '@/components/leads/stage-badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, CardHeader, EmptyState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/client';
import { formatDate, formatDateTime, formatPhone, formatRelative } from '@/lib/format';
import { useDirectory } from '@/lib/use-directory';

import { ContactDialog, LogCallDialog, ScheduleDialog, StageDialog } from './lead-dialogs';
import type { LeadDetailData } from './types';

interface TimelineItem {
  id: string;
  type: string;
  summary: string;
  actorName: string;
  direction: 'IN' | 'OUT' | null;
  createdAt: string;
}

export function LeadDetail({ initial, emailWarning }: { initial: LeadDetailData; emailWarning: boolean }) {
  const api = useApi();
  const router = useRouter();
  const [lead, setLead] = useState(initial);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(
    emailWarning
      ? { tone: 'warning', text: 'Another student uses this email address. Check it is not the same person.' }
      : null,
  );
  const [dialog, setDialog] = useState<null | 'stage' | 'contact' | 'schedule' | 'delete' | { log: string }>(
    null,
  );
  const [timelineKey, setTimelineKey] = useState(0);
  const p = lead.permissions;

  const refresh = useCallback(async () => {
    const res = await api<LeadDetailData>(`/api/leads/${lead.id}`);
    if (res.ok) setLead(res.data);
    setTimelineKey((k) => k + 1);
  }, [api, lead.id]);

  async function patch(body: Record<string, unknown>, success: string) {
    const res = await api(`/api/leads/${lead.id}`, { method: 'PATCH', body });
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    setNotice({ tone: 'success', text: success });
    await refresh();
  }

  async function remove() {
    const res = await api(`/api/students/${lead.student.id}`, { method: 'DELETE' });
    if (!res.ok) return setNotice({ tone: 'danger', text: res.error.message });
    router.push('/app/leads');
    router.refresh();
  }

  const openFollowUps = lead.followUps.filter((f) => !f.completedAt);
  const s = lead.student;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/app/leads"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> All leads
        </Link>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{s.name}</h1>
            <StageBadge stage={lead.stage} />
            <LeadFlags isPotential={lead.isPotential} priority={lead.priority} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <a
              href={`tel:${s.phone}`}
              className="inline-flex items-center gap-1.5 font-medium text-foreground hover:text-primary"
            >
              <Phone className="size-4" /> {formatPhone(s.phone)}
            </a>
            {s.email && (
              <a href={`mailto:${s.email}`} className="inline-flex items-center gap-1.5 hover:text-primary">
                <Mail className="size-4" /> {s.email}
              </a>
            )}
            <span>Source: {lead.source.label}</span>
            <span>Added {formatDate(lead.createdAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.changeStage && (
            <Button variant="secondary" onClick={() => setDialog('stage')}>
              Change stage
            </Button>
          )}
          {p.markPotential && (
            <>
              <Button
                variant="secondary"
                aria-pressed={lead.isPotential}
                onClick={() =>
                  patch(
                    { isPotential: !lead.isPotential },
                    lead.isPotential ? 'Potential flag removed.' : 'Marked as potential.',
                  )
                }
              >
                <Star className={cn(lead.isPotential && 'fill-current text-warning')} /> Potential
              </Button>
              <Button
                variant="secondary"
                aria-pressed={lead.priority === 'HOT'}
                onClick={() =>
                  patch(
                    { priority: lead.priority === 'HOT' ? 'NORMAL' : 'HOT' },
                    lead.priority === 'HOT' ? 'HOT tag removed.' : 'Marked HOT.',
                  )
                }
              >
                <Flame className={cn(lead.priority === 'HOT' && 'text-danger')} /> HOT
              </Button>
            </>
          )}
          {p.scheduleFollowup && (
            <Button onClick={() => setDialog('schedule')}>
              <CalendarPlus /> Schedule call
            </Button>
          )}
        </div>
      </div>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {openFollowUps.length > 0 && (
        <Card className="border-primary/30">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="flex items-center gap-3 text-sm">
              <PhoneCall className="size-4 text-primary" />
              <span>
                Next call <strong>{formatDateTime(openFollowUps[0]!.scheduledAt)}</strong> (
                {formatRelative(openFollowUps[0]!.scheduledAt)}) with {openFollowUps[0]!.assigneeName ?? '—'}
              </span>
              {new Date(openFollowUps[0]!.scheduledAt).getTime() < Date.now() && (
                <Badge tone="danger">Overdue</Badge>
              )}
            </div>
            {p.logDisposition && (
              <Button size="sm" onClick={() => setDialog({ log: openFollowUps[0]!.id })}>
                Log call outcome
              </Button>
            )}
          </div>
        </Card>
      )}

      <Tabs.Root defaultValue="overview">
        <Tabs.List className="flex gap-1 overflow-x-auto border-b border-border" aria-label="Lead sections">
          {[
            ['overview', 'Overview'],
            ['timeline', 'Timeline'],
            ['followups', `Follow-ups (${lead.followUps.length})`],
            ['notes', `Notes (${lead.notes.length})`],
            ['history', 'Stage history'],
            ...(p.documents ? [['documents', 'Documents']] : []),
          ].map(([v, label]) => (
            <Tabs.Trigger
              key={v}
              value={v!}
              className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="overview" className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Contact"
              actions={
                p.editStudent && (
                  <Button size="sm" variant="ghost" onClick={() => setDialog('contact')}>
                    <Pencil /> Edit
                  </Button>
                )
              }
            />
            <dl className="grid gap-x-6 gap-y-4 p-5 text-sm sm:grid-cols-2">
              <Item label="Parent">{s.parentName}</Item>
              <Item label="Alternate number">{s.altPhone ? formatPhone(s.altPhone) : null}</Item>
              <Item label="Town / city">{s.town}</Item>
              <Item label="District">{s.district}</Item>
              <Item label="State">{s.state}</Item>
              {!p.editContactOnly && <Item label="Address">{s.address}</Item>}
              <Item label="Country of interest">{lead.interestCountry}</Item>
              <Item label="Course">{lead.interestCourse}</Item>
              <Item label="Last contacted">
                {lead.lastContactedAt ? formatRelative(lead.lastContactedAt) : 'Not yet'}
              </Item>
              {lead.lostReason && <Item label="Closed because">{lead.lostReason}</Item>}
            </dl>
          </Card>
          <div className="space-y-6">
            <AssignmentCard
              lead={lead}
              onChanged={(msg) => (setNotice({ tone: 'success', text: msg }), refresh())}
              onError={(m) => setNotice({ tone: 'danger', text: m })}
            />
            {lead.otherLeads.length > 0 && (
              <Card>
                <CardHeader title="Earlier enquiries" description="Other leads for this student." />
                <ul className="divide-y divide-border">
                  {lead.otherLeads.map((o) => (
                    <li key={o.id}>
                      <Link
                        href={`/app/leads/${o.id}`}
                        className="flex items-center justify-between px-5 py-3 text-sm hover:bg-surface-muted"
                      >
                        <span>
                          {formatDate(o.createdAt)}
                          {o.interestCountry ? ` · ${o.interestCountry}` : ''}
                        </span>
                        <StageBadge stage={o.stage} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {p.delete && (
              <Button variant="ghost" className="text-danger" onClick={() => setDialog('delete')}>
                <Trash2 /> Delete student
              </Button>
            )}
          </div>
        </Tabs.Content>

        <Tabs.Content value="timeline" className="mt-6">
          <Timeline key={timelineKey} leadId={lead.id} />
        </Tabs.Content>

        <Tabs.Content value="followups" className="mt-6">
          <Card>
            {lead.followUps.length === 0 ? (
              <EmptyState
                icon={<PhoneCall />}
                title="No calls scheduled"
                description="Schedule the first call to put this lead in the queue."
              />
            ) : (
              <ul className="divide-y divide-border">
                {lead.followUps.map((f) => (
                  <li
                    key={f.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium tabular-nums">{formatDateTime(f.scheduledAt)}</span>
                        <DispositionBadge disposition={f.disposition} />
                        {!f.completedAt && new Date(f.scheduledAt).getTime() < Date.now() && (
                          <Badge tone="danger">Overdue</Badge>
                        )}
                        {f.priority === 'HOT' && <Badge tone="danger">HOT</Badge>}
                      </div>
                      <p className="mt-0.5 text-muted-foreground">
                        {f.assigneeName ?? '—'}
                        {f.outcomeNote ? ` — ${f.outcomeNote}` : ''}
                      </p>
                    </div>
                    {!f.completedAt && p.logDisposition && (
                      <Button size="sm" variant="secondary" onClick={() => setDialog({ log: f.id })}>
                        Log outcome
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Tabs.Content>

        <Tabs.Content value="notes" className="mt-6 space-y-4">
          {p.addNote && <NoteComposer leadId={lead.id} onAdded={refresh} />}
          <Card>
            {lead.notes.length === 0 ? (
              <EmptyState icon={<MessageSquarePlus />} title="No notes yet" />
            ) : (
              <ul className="divide-y divide-border">
                {lead.notes.map((n) => (
                  <li key={n.id} className="px-5 py-4 text-sm">
                    <p className="whitespace-pre-wrap">{n.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {n.authorName ?? 'Unknown'} · {formatDateTime(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Tabs.Content>

        <Tabs.Content value="history" className="mt-6">
          <Card>
            <ol className="divide-y divide-border">
              {lead.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3 text-sm">
                  <div>
                    <p>
                      {h.fromStage ? (
                        <>
                          {STAGE_LABEL[h.fromStage]} → <strong>{STAGE_LABEL[h.toStage]}</strong>
                        </>
                      ) : (
                        <>
                          Created as <strong>{STAGE_LABEL[h.toStage]}</strong>
                        </>
                      )}
                    </p>
                    {(h.note || h.reason) && (
                      <p className="mt-0.5 text-muted-foreground">
                        {[h.reason, h.note].filter(Boolean).join(' — ')}
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {h.changedByName ?? 'System'} · {formatDateTime(h.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </Tabs.Content>

        {p.documents && (
          <Tabs.Content value="documents" className="mt-6">
            <StudentDocuments studentId={lead.student.id} canReview={p.verifyDocuments} />
          </Tabs.Content>
        )}
      </Tabs.Root>

      {dialog === 'stage' && (
        <StageDialog
          lead={lead}
          open
          onOpenChange={() => setDialog(null)}
          onSaved={() => (setNotice({ tone: 'success', text: 'Stage updated.' }), refresh())}
        />
      )}
      {dialog === 'contact' && (
        <ContactDialog
          lead={lead}
          open
          onOpenChange={() => setDialog(null)}
          onSaved={(warn) => {
            setNotice(
              warn
                ? { tone: 'warning', text: 'Saved. Another student uses this email address.' }
                : { tone: 'success', text: 'Contact details saved.' },
            );
            refresh();
          }}
        />
      )}
      {dialog === 'schedule' && (
        <ScheduleDialog
          leadId={lead.id}
          open
          onOpenChange={() => setDialog(null)}
          onSaved={() => (setNotice({ tone: 'success', text: 'Call scheduled.' }), refresh())}
        />
      )}
      {dialog && typeof dialog === 'object' && (
        <LogCallDialog
          followUpId={dialog.log}
          currentStage={lead.stage}
          canChangeStage={p.changeStage}
          open
          onOpenChange={() => setDialog(null)}
          onSaved={() => (setNotice({ tone: 'success', text: 'Call outcome saved.' }), refresh())}
        />
      )}
      {dialog === 'delete' && (
        <Dialog
          open
          onOpenChange={() => setDialog(null)}
          size="sm"
          title="Delete this student?"
          description="The student and all their leads leave the workspace. Open calls are closed. An admin can restore the record from the database backup only."
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={remove}>
                Delete
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-foreground">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

function AssignmentCard({
  lead,
  onChanged,
  onError,
}: {
  lead: LeadDetailData;
  onChanged: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const api = useApi();
  const counselors = useDirectory('counselors', lead.permissions.assignCounselor);
  const telecallers = useDirectory('telecallers', lead.permissions.assignTelecaller);
  const [busy, setBusy] = useState(false);

  async function assign(field: 'counselorId' | 'telecallerId', value: string) {
    setBusy(true);
    const res = await api(`/api/leads/${lead.id}`, { method: 'PATCH', body: { [field]: value } });
    setBusy(false);
    if (!res.ok) return onError(res.error.message);
    onChanged(field === 'counselorId' ? 'Counselor updated.' : 'Telecaller updated.');
  }

  return (
    <Card>
      <CardHeader title="Assignment" />
      <div className="space-y-4 p-5 text-sm">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Counselor</p>
          {lead.permissions.assignCounselor ? (
            <Select
              aria-label="Counselor"
              value={lead.counselor?.id ?? ''}
              disabled={busy}
              onChange={(e) => assign('counselorId', e.target.value)}
            >
              <option value="">Unassigned</option>
              {counselors.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          ) : (
            <p>{lead.counselor?.name ?? 'Unassigned'}</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Telecaller</p>
          {lead.permissions.assignTelecaller ? (
            <Select
              aria-label="Telecaller"
              value={lead.telecaller?.id ?? ''}
              disabled={busy}
              onChange={(e) => assign('telecallerId', e.target.value)}
            >
              <option value="">None</option>
              {telecallers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          ) : (
            <p>{lead.telecaller?.name ?? 'None'}</p>
          )}
        </div>
        {lead.assignmentHistory.some((a) => !a.isActive) && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Assignment history</summary>
            <ul className="mt-2 space-y-1">
              {lead.assignmentHistory.map((a) => (
                <li key={a.id}>
                  {a.roleFunction === 'COUNSELOR' ? 'Counselor' : 'Telecaller'}: {a.assigneeName ?? '—'} (
                  {formatDate(a.assignedAt)}
                  {a.endedAt ? ` – ${formatDate(a.endedAt)}` : ', current'})
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

function NoteComposer({ leadId, onAdded }: { leadId: string; onAdded: () => void }) {
  const api = useApi();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setError(null);
    const res = await api(`/api/leads/${leadId}/notes`, { body: { body } });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setBody('');
    onAdded();
  }
  return (
    <Card className="p-4">
      {error && (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <Textarea
        aria-label="New note"
        placeholder="Add a note…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
      />
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={add} loading={busy} disabled={!body.trim()}>
          Add note
        </Button>
      </div>
    </Card>
  );
}

const TYPE_TONE: Record<string, 'primary' | 'success' | 'info' | 'warning' | 'neutral'> = {
  CALL: 'success',
  STATUS_CHANGE: 'primary',
  NOTE: 'info',
  ASSIGNMENT: 'warning',
  SYSTEM: 'neutral',
};

function Timeline({ leadId }: { leadId: string }) {
  const api = useApi();
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      const res = await api<TimelineItem[]>(
        `/api/leads/${leadId}/timeline${after ? `?cursor=${encodeURIComponent(after)}` : ''}`,
      );
      if (!res.ok) return setError(res.error.message);
      setItems((prev) => (after && prev ? [...prev, ...res.data] : res.data));
      setCursor((res.meta?.['nextCursor'] as string | null) ?? null);
    },
    [api, leadId],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!items)
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  if (items.length === 0) return <EmptyState title="Nothing on the timeline yet" />;
  return (
    <Card className="p-5">
      <ol className="relative space-y-5 border-l border-border pl-6">
        {items.map((i) => (
          <li key={i.id} className="relative">
            <span
              className="absolute -left-[29px] top-1 size-2.5 rounded-full border-2 border-surface bg-primary"
              aria-hidden
            />
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TYPE_TONE[i.type] ?? 'neutral'}>{i.type.replace('_', ' ').toLowerCase()}</Badge>
              <span className="text-xs text-muted-foreground">
                {i.actorName} · {formatDateTime(i.createdAt)}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm">{i.summary}</p>
          </li>
        ))}
      </ol>
      {cursor && (
        <div className="mt-5">
          <Button variant="secondary" size="sm" onClick={() => load(cursor)}>
            Show older
          </Button>
        </div>
      )}
    </Card>
  );
}
