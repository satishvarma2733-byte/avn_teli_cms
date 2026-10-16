'use client';

import {
  DISPOSITION_LABEL,
  DISPOSITION_SUGGESTS,
  LEAD_STAGES,
  NEGATIVE_STAGES,
  STAGE_LABEL,
} from '@avn-cms/core/schemas';
import type { CallDisposition, LeadStage } from '@avn-cms/db/enums';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { fromLocalInput, toLocalInput } from '@/lib/format';

import type { LeadDetailData } from './types';

function useSubmit() {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function submit(path: string, method: string, body: unknown, onOk: () => void) {
    setBusy(true);
    setError(null);
    setFields({});
    const res = await api(path, { method, body });
    setBusy(false);
    if (!res.ok) {
      setFields(res.error.details?.fields ?? {});
      setError(res.error.message);
      return;
    }
    onOk();
  }
  return { busy, error, fields, submit, reset: () => (setError(null), setFields({})) };
}

export function StageDialog({
  lead,
  open,
  onOpenChange,
  onSaved,
}: {
  lead: LeadDetailData;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [stage, setStage] = useState<LeadStage>(lead.stage);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const s = useSubmit();
  const closing = NEGATIVE_STAGES.includes(stage) && stage !== 'DUPLICATE';
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change stage"
      description="Every stage change is saved to the lead's history."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={s.busy}
            disabled={stage === lead.stage}
            onClick={() =>
              s.submit(
                `/api/leads/${lead.id}`,
                'PATCH',
                { stage, ...(note ? { stageNote: note } : {}), ...(reason ? { lostReason: reason } : {}) },
                () => {
                  onOpenChange(false);
                  onSaved();
                },
              )
            }
          >
            Save stage
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {s.error && <Alert tone="danger">{s.error}</Alert>}
        <Field id="stage" label="Stage">
          <Select id="stage" value={stage} onChange={(e) => setStage(e.target.value as LeadStage)}>
            {LEAD_STAGES.map((x) => (
              <option key={x} value={x}>
                {STAGE_LABEL[x]}
              </option>
            ))}
          </Select>
        </Field>
        {closing && (
          <Field id="reason" label="Reason" required error={s.fields['lostReason']}>
            <Input
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Chose another consultancy"
            />
          </Field>
        )}
        <Field id="stage-note" label="Note">
          <Textarea id="stage-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </Field>
      </div>
    </Dialog>
  );
}

export function ContactDialog({
  lead,
  open,
  onOpenChange,
  onSaved,
}: {
  lead: LeadDetailData;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (warning: boolean) => void;
}) {
  const st = lead.student;
  const phoneOnly = lead.permissions.editContactOnly;
  const [form, setForm] = useState<Record<string, string>>({
    name: st.name,
    parentName: st.parentName ?? '',
    phone: st.phone,
    altPhone: st.altPhone ?? '',
    email: st.email ?? '',
    town: st.town ?? '',
    district: st.district ?? '',
    state: st.state ?? '',
    address: st.address ?? '',
  });
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (k: string) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    const original: Record<string, string> = {
      name: st.name,
      parentName: st.parentName ?? '',
      phone: st.phone,
      altPhone: st.altPhone ?? '',
      email: st.email ?? '',
      town: st.town ?? '',
      district: st.district ?? '',
      state: st.state ?? '',
      address: st.address ?? '',
    };
    const changed = Object.fromEntries(
      Object.entries(form).filter(
        ([k, v]) => v !== original[k] && (!phoneOnly || k === 'phone' || k === 'altPhone'),
      ),
    );
    if (Object.keys(changed).length === 0) return onOpenChange(false);
    setBusy(true);
    setError(null);
    setFields({});
    const res = await api<{ possibleDuplicateEmail: boolean }>(`/api/students/${st.id}`, {
      method: 'PATCH',
      body: changed,
    });
    setBusy(false);
    if (!res.ok) {
      setFields(res.error.details?.fields ?? {});
      setError(res.error.message);
      return;
    }
    onOpenChange(false);
    onSaved(res.data.possibleDuplicateEmail);
  }

  const input = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <Field id={`c-${k}`} label={label} error={fields[k]}>
      <Input
        id={`c-${k}`}
        value={form[k]}
        onChange={set(k)}
        disabled={phoneOnly && k !== 'phone' && k !== 'altPhone'}
        {...props}
      />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Edit contact details"
      description={phoneOnly ? 'Telecallers can correct phone numbers.' : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {input('name', 'Student name')}
          {input('parentName', 'Parent name')}
          {input('phone', 'Mobile number', { type: 'tel' })}
          {input('altPhone', 'Alternate number', { type: 'tel' })}
          {!phoneOnly && input('email', 'Email', { type: 'email' })}
          {input('town', 'Town / city')}
          {input('district', 'District')}
          {input('state', 'State')}
          {!phoneOnly && input('address', 'Address')}
        </div>
      </div>
    </Dialog>
  );
}

export function ScheduleDialog({
  leadId,
  open,
  onOpenChange,
  onSaved,
}: {
  leadId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3_600_000)));
  const [priority, setPriority] = useState<'NORMAL' | 'HOT'>('NORMAL');
  const [note, setNote] = useState('');
  const s = useSubmit();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Schedule a call"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={s.busy}
            onClick={() =>
              s.submit(
                '/api/followups',
                'POST',
                { leadId, scheduledAt: fromLocalInput(when), priority, ...(note ? { note } : {}) },
                () => {
                  onOpenChange(false);
                  onSaved();
                },
              )
            }
          >
            Schedule
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {s.error && <Alert tone="danger">{s.error}</Alert>}
        <Field id="when" label="Date and time" error={s.fields['scheduledAt']}>
          <Input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field id="fu-priority" label="Priority">
          <Select
            id="fu-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as 'NORMAL' | 'HOT')}
          >
            <option value="NORMAL">Normal</option>
            <option value="HOT">HOT</option>
          </Select>
        </Field>
        <Field id="fu-note" label="Note for the caller">
          <Textarea id="fu-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
      </div>
    </Dialog>
  );
}

const LOGGABLE: CallDisposition[] = [
  'COMPLETED',
  'NO_ANSWER',
  'BUSY',
  'SWITCHED_OFF',
  'CALL_BACK_LATER',
  'INTERESTED',
  'NOT_INTERESTED',
  'AWAITING_FEEDBACK',
];

/** Log what happened on a call; optionally book the next one and apply the suggested stage. */
export function LogCallDialog({
  followUpId,
  currentStage,
  canChangeStage = true,
  open,
  onOpenChange,
  onSaved,
}: {
  followUpId: string;
  currentStage: LeadStage;
  canChangeStage?: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [disposition, setDisposition] = useState<CallDisposition>('COMPLETED');
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');
  const suggested = DISPOSITION_SUGGESTS[disposition];
  const [applyStage, setApplyStage] = useState(true);
  const s = useSubmit();
  const offerStage = canChangeStage && suggested && suggested !== currentStage;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Log call outcome"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={s.busy}
            onClick={() =>
              s.submit(
                `/api/followups/${followUpId}`,
                'PATCH',
                {
                  disposition,
                  ...(note ? { outcomeNote: note } : {}),
                  ...(next ? { nextCallAt: fromLocalInput(next) } : {}),
                  ...(offerStage && applyStage ? { applyStage: suggested } : {}),
                },
                () => {
                  onOpenChange(false);
                  onSaved();
                },
              )
            }
          >
            Save outcome
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {s.error && <Alert tone="danger">{s.error}</Alert>}
        <Field id="disposition" label="What happened?">
          <Select
            id="disposition"
            value={disposition}
            onChange={(e) => setDisposition(e.target.value as CallDisposition)}
          >
            {LOGGABLE.map((d) => (
              <option key={d} value={d}>
                {DISPOSITION_LABEL[d]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="outcome" label="Call notes" hint="What was said — this goes on the timeline.">
          <Textarea id="outcome" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </Field>
        <Field
          id="next"
          label="Next call"
          hint="Optional. Books the next follow-up right away."
          error={s.fields['nextCallAt']}
        >
          <Input id="next" type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        {offerStage && (
          <label className="flex items-start gap-2 rounded-lg bg-surface-muted p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--primary)]"
              checked={applyStage}
              onChange={(e) => setApplyStage(e.target.checked)}
            />
            <span>
              Also move the lead to <strong>{STAGE_LABEL[suggested]}</strong>
              <span className="block text-xs text-muted-foreground">
                Currently {STAGE_LABEL[currentStage]}.
              </span>
            </span>
          </label>
        )}
      </div>
    </Dialog>
  );
}
