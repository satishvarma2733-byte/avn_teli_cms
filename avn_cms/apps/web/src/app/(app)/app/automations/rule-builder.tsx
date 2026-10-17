'use client';

import {
  ACTIONS_FOR_TRIGGER,
  ACTION_LABEL,
  ASSIGN_ROLES_FOR_TRIGGER,
  AUTOMATION_TRIGGERS,
  MAX_ACTIONS,
  NOTIFY_TARGETS_FOR_TRIGGER,
  NOTIFY_TARGET_LABEL,
  TRIGGER_LABEL,
  type ActionType,
  type AutomationAction,
  type AutomationTriggerCode,
  type NotifyTarget,
} from '@avn-cms/core/automation';
import { STAGE_LABEL } from '@avn-cms/core/schemas';
import type { LeadStage } from '@avn-cms/db/enums';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/primitives';
import { useApi } from '@/lib/client';
import { useDirectory } from '@/lib/use-directory';

import { humanMinutes, type Rule } from './types';

// ── The form's state ─────────────────────────────────────────────────────────

interface ActionDraft {
  key: number;
  type: ActionType;
  role: 'COUNSELOR' | 'TELECALLER';
  to: NotifyTarget;
  title: string;
  body: string;
  afterMinutes: string;
  assignee: 'owner' | 'counselor' | 'telecaller';
}

interface Draft {
  name: string;
  isActive: boolean;
  trigger: AutomationTriggerCode;
  // Conditions (only those of the chosen trigger are sent).
  statuses: ('NEW' | 'DUPLICATE')[];
  sourceIds: string[];
  countries: string;
  minNeetScore: string;
  minutes: string;
  minutesOverdue: string;
  priority: '' | 'NORMAL' | 'HOT';
  toStage: string;
  fromStage: string;
  actions: ActionDraft[];
}

let nextKey = 1;

function blankAction(trigger: AutomationTriggerCode, type?: ActionType): ActionDraft {
  // Telling someone is the usual first step; every trigger allows it.
  const kind = type ?? 'notify';
  return {
    key: nextKey++,
    type: kind,
    role: ASSIGN_ROLES_FOR_TRIGGER[trigger][0] ?? 'COUNSELOR',
    to: NOTIFY_TARGETS_FOR_TRIGGER[trigger][0]!,
    title: '',
    body: '',
    afterMinutes: '1440',
    assignee: 'owner',
  };
}

function blankDraft(): Draft {
  return {
    name: '',
    isActive: true,
    trigger: 'WEB_LEAD_CREATED',
    statuses: [],
    sourceIds: [],
    countries: '',
    minNeetScore: '',
    minutes: '',
    minutesOverdue: '',
    priority: '',
    toStage: 'INTERESTED',
    fromStage: '',
    actions: [blankAction('WEB_LEAD_CREATED')],
  };
}

function draftFromRule(rule: Rule): Draft {
  const c = rule.conditions;
  const str = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? String(v) : '');
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    name: rule.name,
    isActive: rule.isActive,
    trigger: rule.trigger,
    statuses: list(c['statuses']) as Draft['statuses'],
    sourceIds: list(c['sourceIds']),
    countries: list(c['countries']).join(', '),
    minNeetScore: str(c['minNeetScore']),
    minutes: str(c['minutes']),
    minutesOverdue: str(c['minutesOverdue']),
    priority: (c['priority'] === 'NORMAL' || c['priority'] === 'HOT'
      ? c['priority']
      : '') as Draft['priority'],
    toStage: str(c['toStage']) || 'INTERESTED',
    fromStage: str(c['fromStage']),
    actions: rule.actions.map((a) => {
      const base = blankAction(rule.trigger, a.type);
      switch (a.type) {
        case 'assign_round_robin':
          return { ...base, role: a.role };
        case 'notify':
          return { ...base, to: a.to, title: a.title, body: a.body ?? '' };
        case 'schedule_followup':
          return { ...base, afterMinutes: String(a.afterMinutes), assignee: a.assignee };
        default:
          return base;
      }
    }),
  };
}

const whole = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

function conditionsOf(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (d.trigger) {
    case 'WEB_LEAD_CREATED': {
      if (d.statuses.length) out['statuses'] = d.statuses;
      if (d.sourceIds.length) out['sourceIds'] = d.sourceIds;
      const countries = d.countries
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      if (countries.length) out['countries'] = countries;
      const score = whole(d.minNeetScore);
      if (score !== undefined) out['minNeetScore'] = score;
      break;
    }
    case 'LEAD_UNCONTACTED': {
      const minutes = whole(d.minutes);
      if (minutes !== undefined) out['minutes'] = minutes;
      if (d.sourceIds.length) out['sourceIds'] = d.sourceIds;
      break;
    }
    case 'FOLLOWUP_OVERDUE': {
      const minutes = whole(d.minutesOverdue);
      if (minutes !== undefined) out['minutesOverdue'] = minutes;
      if (d.priority) out['priority'] = d.priority;
      break;
    }
    case 'STAGE_CHANGED':
      out['toStage'] = d.toStage;
      if (d.fromStage) out['fromStage'] = d.fromStage;
      break;
  }
  return out;
}

function actionOf(a: ActionDraft): AutomationAction | Record<string, unknown> {
  switch (a.type) {
    case 'assign_round_robin':
      return { type: a.type, role: a.role };
    case 'notify':
      return { type: a.type, to: a.to, title: a.title, ...(a.body.trim() ? { body: a.body } : {}) };
    case 'schedule_followup':
      return { type: a.type, afterMinutes: whole(a.afterMinutes) ?? NaN, assignee: a.assignee };
    default:
      return { type: a.type };
  }
}

const ASSIGNEE_LABEL = {
  owner: 'Whoever owns the lead',
  counselor: 'The lead’s counselor',
  telecaller: 'The lead’s telecaller',
} as const;

// ── The dialog ───────────────────────────────────────────────────────────────

export function RuleBuilder({
  rule,
  onClose,
  onSaved,
}: {
  rule: Rule | null;
  onClose: () => void;
  onSaved: (saved: Rule, created: boolean) => void;
}) {
  const api = useApi();
  const sources = useDirectory('sources');
  const [draft, setDraft] = useState<Draft>(() => (rule ? draftFromRule(rule) : blankDraft()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setAction = (key: number, patch: Partial<ActionDraft>) =>
    setDraft((d) => ({ ...d, actions: d.actions.map((a) => (a.key === key ? { ...a, ...patch } : a)) }));

  /** A different trigger means different conditions, and some actions no longer fit. */
  function changeTrigger(trigger: AutomationTriggerCode) {
    setDraft((d) => {
      const allowed = ACTIONS_FOR_TRIGGER[trigger];
      const kept = d.actions
        .filter((a) => allowed.includes(a.type))
        .map((a) => ({
          ...a,
          to: NOTIFY_TARGETS_FOR_TRIGGER[trigger].includes(a.to)
            ? a.to
            : NOTIFY_TARGETS_FOR_TRIGGER[trigger][0]!,
          role: ASSIGN_ROLES_FOR_TRIGGER[trigger].includes(a.role)
            ? a.role
            : (ASSIGN_ROLES_FOR_TRIGGER[trigger][0] ?? a.role),
        }));
      return {
        ...blankDraft(),
        name: d.name,
        isActive: d.isActive,
        trigger,
        actions: kept.length ? kept : [blankAction(trigger)],
      };
    });
    setFields({});
  }

  async function save() {
    setBusy(true);
    setError(null);
    setFields({});
    const body = {
      name: draft.name,
      isActive: draft.isActive,
      trigger: draft.trigger,
      conditions: conditionsOf(draft),
      actions: draft.actions.map(actionOf),
    };
    const res = rule
      ? await api<Rule>(`/api/automations/${rule.id}`, { method: 'PATCH', body })
      : await api<Rule>('/api/automations', { body });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      setFields(res.error.details?.fields ?? {});
      return;
    }
    onSaved(res.data, !rule);
  }

  const trigger = draft.trigger;
  const err = (path: string) => fields[path];

  return (
    <Dialog
      open
      onOpenChange={onClose}
      size="lg"
      title={rule ? 'Edit rule' : 'New rule'}
      description="When something happens and it fits the conditions, the actions run. Actions never start other rules."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            {rule ? 'Save rule' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {error && <Alert tone="danger">{error}</Alert>}

        <Field id="rule-name" label="Name" required error={err('name')}>
          <Input
            id="rule-name"
            value={draft.name}
            maxLength={100}
            placeholder="For example: Tell me about hot leads"
            aria-invalid={err('name') ? true : undefined}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>

        <section className="space-y-4" aria-labelledby="rule-when">
          <h3 id="rule-when" className="text-sm font-semibold">
            When
          </h3>
          <Field id="rule-trigger" label="This happens">
            <Select
              id="rule-trigger"
              value={trigger}
              onChange={(e) => changeTrigger(e.target.value as AutomationTriggerCode)}
            >
              {AUTOMATION_TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>

          {trigger === 'WEB_LEAD_CREATED' && (
            <>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Submissions</legend>
                {(
                  [
                    ['NEW', 'New (a phone number we don’t know yet)'],
                    ['DUPLICATE', 'Repeat (a student who is already in the system)'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={draft.statuses.includes(value)}
                      onChange={(e) =>
                        set({
                          statuses: e.target.checked
                            ? [...draft.statuses, value]
                            : draft.statuses.filter((s) => s !== value),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
                <p className="text-xs text-muted-foreground">Tick none to include both.</p>
              </fieldset>
              <SourcePicker
                sources={sources}
                value={draft.sourceIds}
                onChange={(sourceIds) => set({ sourceIds })}
              />
              <Field
                id="rule-countries"
                label="Interested in (optional)"
                hint="Countries, separated by commas. Leave empty for any."
                error={err('conditions.countries')}
              >
                <Input
                  id="rule-countries"
                  value={draft.countries}
                  placeholder="Russia, Georgia"
                  onChange={(e) => set({ countries: e.target.value })}
                />
              </Field>
              <Field
                id="rule-neet"
                label="Lowest NEET score (optional)"
                error={err('conditions.minNeetScore')}
              >
                <Input
                  id="rule-neet"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={720}
                  value={draft.minNeetScore}
                  onChange={(e) => set({ minNeetScore: e.target.value })}
                />
              </Field>
            </>
          )}

          {trigger === 'LEAD_UNCONTACTED' && (
            <>
              <MinutesField
                id="rule-minutes"
                label="Not contacted for (minutes)"
                value={draft.minutes}
                empty="Leave empty to use the workspace’s “uncontacted” time from Settings."
                error={err('conditions.minutes')}
                onChange={(minutes) => set({ minutes })}
              />
              <SourcePicker
                sources={sources}
                value={draft.sourceIds}
                onChange={(sourceIds) => set({ sourceIds })}
              />
            </>
          )}

          {trigger === 'FOLLOWUP_OVERDUE' && (
            <>
              <MinutesField
                id="rule-overdue"
                label="Overdue by (minutes)"
                value={draft.minutesOverdue}
                empty="Leave empty for 24 hours."
                error={err('conditions.minutesOverdue')}
                onChange={(minutesOverdue) => set({ minutesOverdue })}
              />
              <Field id="rule-priority" label="Priority (optional)">
                <Select
                  id="rule-priority"
                  value={draft.priority}
                  onChange={(e) => set({ priority: e.target.value as Draft['priority'] })}
                >
                  <option value="">Any</option>
                  <option value="NORMAL">Normal</option>
                  <option value="HOT">Hot</option>
                </Select>
              </Field>
            </>
          )}

          {trigger === 'STAGE_CHANGED' && (
            <>
              <Field id="rule-to-stage" label="Changes to" required error={err('conditions.toStage')}>
                <Select
                  id="rule-to-stage"
                  value={draft.toStage}
                  onChange={(e) => set({ toStage: e.target.value })}
                >
                  {(Object.keys(STAGE_LABEL) as LeadStage[]).map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="rule-from-stage" label="Coming from (optional)" error={err('conditions.fromStage')}>
                <Select
                  id="rule-from-stage"
                  value={draft.fromStage}
                  onChange={(e) => set({ fromStage: e.target.value })}
                >
                  <option value="">Any stage</option>
                  {(Object.keys(STAGE_LABEL) as LeadStage[]).map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </section>

        <section className="space-y-3" aria-labelledby="rule-then">
          <h3 id="rule-then" className="text-sm font-semibold">
            Then
          </h3>
          {err('actions') && (
            <p role="alert" className="text-xs text-danger">
              {err('actions')}
            </p>
          )}
          <ol className="space-y-3">
            {draft.actions.map((action, index) => (
              <li key={action.key} className="rounded-lg border border-border p-3">
                <ActionEditor
                  index={index}
                  action={action}
                  trigger={trigger}
                  errors={fields}
                  onChange={(patch) => setAction(action.key, patch)}
                  onRemove={
                    draft.actions.length > 1
                      ? () => set({ actions: draft.actions.filter((a) => a.key !== action.key) })
                      : null
                  }
                />
              </li>
            ))}
          </ol>
          {draft.actions.length < MAX_ACTIONS && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => set({ actions: [...draft.actions, blankAction(trigger)] })}
            >
              <Plus /> Add an action
            </Button>
          )}
        </section>

        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={draft.isActive}
            onChange={(e) => set({ isActive: e.target.checked })}
          />
          Rule is on
        </label>
      </div>
    </Dialog>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function MinutesField({
  id,
  label,
  value,
  empty,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  empty: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const words = humanMinutes(Number(value));
  return (
    <Field
      id={id}
      label={label}
      hint={value.trim() === '' ? empty : words ? `That is ${words}.` : undefined}
      error={error}
    >
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function SourcePicker({
  sources,
  value,
  onChange,
}: {
  sources: { id: string; label?: string; name?: string }[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  if (sources.length === 0) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Sources (optional)</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {sources.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={value.includes(s.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, s.id] : value.filter((v) => v !== s.id))
              }
            />
            {s.label ?? s.name}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Tick none to include every source.</p>
    </fieldset>
  );
}

function ActionEditor({
  index,
  action,
  trigger,
  errors,
  onChange,
  onRemove,
}: {
  index: number;
  action: ActionDraft;
  trigger: AutomationTriggerCode;
  errors: Record<string, string>;
  onChange: (patch: Partial<ActionDraft>) => void;
  onRemove: (() => void) | null;
}) {
  const id = `action-${action.key}`;
  const at = (field: string) => errors[`actions.${index}.${field}`];
  const targets = NOTIFY_TARGETS_FOR_TRIGGER[trigger];
  const roles = ASSIGN_ROLES_FOR_TRIGGER[trigger];
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <Field id={`${id}-type`} label={`Action ${index + 1}`} className="flex-1" error={at('type')}>
          <Select
            id={`${id}-type`}
            value={action.type}
            onChange={(e) => onChange({ type: e.target.value as ActionType })}
          >
            {ACTIONS_FOR_TRIGGER[trigger].map((t) => (
              <option key={t} value={t}>
                {ACTION_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {onRemove && (
          <Button variant="ghost" size="icon" onClick={onRemove} aria-label={`Remove action ${index + 1}`}>
            <Trash2 />
          </Button>
        )}
      </div>

      {action.type === 'assign_round_robin' && (
        <Field
          id={`${id}-role`}
          label="Assign to"
          hint="Active people in that role take turns: whoever was picked longest ago goes next."
          error={at('role')}
        >
          <Select
            id={`${id}-role`}
            value={action.role}
            onChange={(e) => onChange({ role: e.target.value as ActionDraft['role'] })}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {r === 'COUNSELOR' ? 'A counselor' : 'A telecaller'}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {action.type === 'notify' && (
        <>
          <Field id={`${id}-to`} label="Tell" error={at('to')}>
            <Select
              id={`${id}-to`}
              value={action.to}
              onChange={(e) => onChange({ to: e.target.value as NotifyTarget })}
            >
              {targets.map((t) => (
                <option key={t} value={t}>
                  {NOTIFY_TARGET_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id={`${id}-title`}
            label="Title"
            required
            hint="You can use {name}, {stage}, {minutes} and {country}."
            error={at('title')}
          >
            <Input
              id={`${id}-title`}
              value={action.title}
              maxLength={120}
              placeholder="New web lead: {name}"
              aria-invalid={at('title') ? true : undefined}
              onChange={(e) => onChange({ title: e.target.value })}
            />
          </Field>
          <Field id={`${id}-body`} label="Message (optional)" error={at('body')}>
            <Textarea
              id={`${id}-body`}
              value={action.body}
              maxLength={300}
              rows={2}
              onChange={(e) => onChange({ body: e.target.value })}
            />
          </Field>
        </>
      )}

      {action.type === 'schedule_followup' && (
        <>
          <MinutesField
            id={`${id}-after`}
            label="Call after (minutes)"
            value={action.afterMinutes}
            empty="How long from now the call is due."
            error={at('afterMinutes')}
            onChange={(afterMinutes) => onChange({ afterMinutes })}
          />
          <Field id={`${id}-assignee`} label="Who calls" error={at('assignee')}>
            <Select
              id={`${id}-assignee`}
              value={action.assignee}
              onChange={(e) => onChange({ assignee: e.target.value as ActionDraft['assignee'] })}
            >
              {(Object.keys(ASSIGNEE_LABEL) as (keyof typeof ASSIGNEE_LABEL)[]).map((k) => (
                <option key={k} value={k}>
                  {ASSIGNEE_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}

      {action.type === 'escalate' && (
        <p className="text-sm text-muted-foreground">
          The call is marked escalated, and the person who owns it and every admin are notified.
        </p>
      )}
      {action.type === 'stop_reminders' && (
        <p className="text-sm text-muted-foreground">
          The lead’s open follow-up calls (the ones not made yet) are removed, so nobody is reminded to call
          someone who has already enrolled.
        </p>
      )}
    </div>
  );
}
