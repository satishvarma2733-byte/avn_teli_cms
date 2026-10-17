/**
 * Automation rules: what a rule is made of. Client-safe (zod and enum constants only), so the rule
 * builder validates with the same definitions the server enforces.
 *
 * A rule is "when TRIGGER happens, if CONDITIONS hold, do ACTIONS". Actions never start other
 * rules, so rules cannot loop.
 */
import { LeadStage } from '@avn-cms/db/enums';
import { z } from 'zod';

import { STAGE_LABEL } from '../schemas';

export const AUTOMATION_TRIGGERS = [
  'WEB_LEAD_CREATED',
  'LEAD_UNCONTACTED',
  'FOLLOWUP_OVERDUE',
  'STAGE_CHANGED',
] as const;
export type AutomationTriggerCode = (typeof AUTOMATION_TRIGGERS)[number];

export const TRIGGER_LABEL: Record<AutomationTriggerCode, string> = {
  WEB_LEAD_CREATED: 'A new web lead arrives',
  LEAD_UNCONTACTED: 'A lead has not been contacted',
  FOLLOWUP_OVERDUE: 'A follow-up call is overdue',
  STAGE_CHANGED: 'A lead’s stage changes',
};

// ── Limits ───────────────────────────────────────────────────────────────────

export const MAX_RULES = 50;
export const MAX_ACTIONS = 5;
/** Time-based rules only look at recent records, so turning one on never floods people about old ones. */
export const UNCONTACTED_LOOKBACK_DAYS = 3;
export const OVERDUE_LOOKBACK_DAYS = 7;
export const DEFAULT_OVERDUE_MINUTES = 24 * 60;

// ── Conditions ───────────────────────────────────────────────────────────────

const uuid = z.uuid('Invalid id.');
const sourceIds = z.array(uuid).min(1).max(20).optional();

export const conditionSchemas = {
  WEB_LEAD_CREATED: z
    .object({
      /** Only submissions with this status (New = not a repeat of a known student). */
      statuses: z
        .array(z.enum(['NEW', 'DUPLICATE']))
        .min(1)
        .optional(),
      sourceIds,
      countries: z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional(),
      minNeetScore: z.number().int().min(0).max(720).optional(),
    })
    .strict(),
  LEAD_UNCONTACTED: z
    .object({
      /** Minutes after the lead arrived. Left out: the workspace setting “uncontacted minutes”. */
      minutes: z.number().int().min(5).max(10_080).optional(),
      sourceIds,
    })
    .strict(),
  FOLLOWUP_OVERDUE: z
    .object({
      /** Minutes past the call's time. Left out: 24 hours. */
      minutesOverdue: z.number().int().min(5).max(43_200).optional(),
      priority: z.enum(['NORMAL', 'HOT']).optional(),
    })
    .strict(),
  STAGE_CHANGED: z
    .object({
      toStage: z.enum(LeadStage),
      fromStage: z.enum(LeadStage).optional(),
    })
    .strict(),
} as const satisfies Record<AutomationTriggerCode, z.ZodType>;

export type AutomationConditions<T extends AutomationTriggerCode = AutomationTriggerCode> = z.output<
  (typeof conditionSchemas)[T]
>;

// ── Actions ──────────────────────────────────────────────────────────────────

export const NOTIFY_TARGETS = ['admins', 'counselor', 'telecaller', 'assigned', 'assignee'] as const;
export type NotifyTarget = (typeof NOTIFY_TARGETS)[number];

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign_round_robin'), role: z.enum(['COUNSELOR', 'TELECALLER']) }).strict(),
  z
    .object({
      type: z.literal('notify'),
      to: z.enum(NOTIFY_TARGETS),
      title: z.string().trim().min(1, 'Write the notification’s title.').max(120),
      body: z.string().trim().max(300).optional(),
    })
    .strict(),
  z.object({ type: z.literal('escalate') }).strict(),
  z
    .object({
      type: z.literal('schedule_followup'),
      afterMinutes: z.number().int().min(5).max(43_200),
      assignee: z.enum(['owner', 'counselor', 'telecaller']),
    })
    .strict(),
  z.object({ type: z.literal('stop_reminders') }).strict(),
]);
export type AutomationAction = z.output<typeof actionSchema>;
export type ActionType = AutomationAction['type'];

export const ACTION_LABEL: Record<ActionType, string> = {
  assign_round_robin: 'Assign in turn (round-robin)',
  notify: 'Send a notification',
  escalate: 'Escalate to the admins',
  schedule_followup: 'Schedule a follow-up call',
  stop_reminders: 'Stop reminders',
};

/** Which actions make sense after which trigger (a web lead is not a lead yet, so it has no calls). */
export const ACTIONS_FOR_TRIGGER: Record<AutomationTriggerCode, readonly ActionType[]> = {
  WEB_LEAD_CREATED: ['assign_round_robin', 'notify'],
  LEAD_UNCONTACTED: ['assign_round_robin', 'notify', 'schedule_followup'],
  FOLLOWUP_OVERDUE: ['notify', 'escalate'],
  STAGE_CHANGED: ['assign_round_robin', 'notify', 'schedule_followup', 'stop_reminders'],
};

export const NOTIFY_TARGETS_FOR_TRIGGER: Record<AutomationTriggerCode, readonly NotifyTarget[]> = {
  WEB_LEAD_CREATED: ['admins', 'assigned'],
  LEAD_UNCONTACTED: ['admins', 'counselor', 'telecaller', 'assigned'],
  FOLLOWUP_OVERDUE: ['admins', 'assignee', 'counselor', 'telecaller'],
  STAGE_CHANGED: ['admins', 'counselor', 'telecaller', 'assigned'],
};

export const NOTIFY_TARGET_LABEL: Record<NotifyTarget, string> = {
  admins: 'The admins',
  counselor: 'The lead’s counselor',
  telecaller: 'The lead’s telecaller',
  assigned: 'Whoever the rule just assigned',
  assignee: 'Whoever owns the call',
};

/** A web lead can only be routed to a counselor (telecallers work leads, not enquiries). */
export const ASSIGN_ROLES_FOR_TRIGGER: Record<
  AutomationTriggerCode,
  readonly ('COUNSELOR' | 'TELECALLER')[]
> = {
  WEB_LEAD_CREATED: ['COUNSELOR'],
  LEAD_UNCONTACTED: ['COUNSELOR', 'TELECALLER'],
  FOLLOWUP_OVERDUE: [],
  STAGE_CHANGED: ['COUNSELOR', 'TELECALLER'],
};

// ── A whole rule ─────────────────────────────────────────────────────────────

export const ruleInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the rule a name.').max(100),
    isActive: z.boolean().default(true),
    trigger: z.enum(AUTOMATION_TRIGGERS),
    conditions: z.record(z.string(), z.unknown()).default({}),
    actions: z.array(actionSchema).min(1, 'Add at least one action.').max(MAX_ACTIONS),
  })
  .superRefine((rule, ctx) => {
    const parsed = conditionSchemas[rule.trigger].safeParse(rule.conditions);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', path: ['conditions', ...issue.path], message: issue.message });
      }
    }
    rule.actions.forEach((action, i) => {
      if (!ACTIONS_FOR_TRIGGER[rule.trigger].includes(action.type)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'type'],
          message: `“${ACTION_LABEL[action.type]}” doesn’t fit “${TRIGGER_LABEL[rule.trigger]}”.`,
        });
      }
      if (action.type === 'notify' && !NOTIFY_TARGETS_FOR_TRIGGER[rule.trigger].includes(action.to)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'to'],
          message: `“${NOTIFY_TARGET_LABEL[action.to]}” isn’t known for this trigger.`,
        });
      }
      if (
        action.type === 'assign_round_robin' &&
        !ASSIGN_ROLES_FOR_TRIGGER[rule.trigger].includes(action.role)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'role'],
          message: 'This kind of record can’t be assigned to that role.',
        });
      }
    });
  });
export type RuleInput = z.output<typeof ruleInputSchema>;

export const rulePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    isActive: z.boolean(),
    trigger: z.enum(AUTOMATION_TRIGGERS),
    conditions: z.record(z.string(), z.unknown()),
    actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
  })
  .partial();
export type RulePatch = z.output<typeof rulePatchSchema>;

export const runListQuerySchema = z.object({
  ruleId: uuid.optional(),
  status: z.enum(['PENDING', 'RUNNING', 'DONE', 'SKIPPED', 'FAILED']).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── What an event carries ────────────────────────────────────────────────────

/** Snapshots taken when the thing happened; the actions and the run log work from these. */
export interface WebLeadEventPayload {
  webLeadId: string;
  name: string;
  status: 'NEW' | 'DUPLICATE' | 'CONVERTED' | 'SPAM' | 'REJECTED';
  sourceId: string | null;
  country: string | null;
  neetScore: number | null;
}
export interface LeadEventPayload {
  leadId: string;
  studentId: string;
  name: string;
  sourceId: string | null;
}
export interface UncontactedEventPayload extends LeadEventPayload {
  minutes: number;
}
export interface OverdueEventPayload extends LeadEventPayload {
  followUpId: string;
  assigneeId: string;
  priority: 'NORMAL' | 'HOT';
  scheduledAt: string;
  minutesOverdue: number;
}
export interface StageEventPayload extends LeadEventPayload {
  from: LeadStage;
  to: LeadStage;
}

export interface EventPayloads {
  WEB_LEAD_CREATED: WebLeadEventPayload;
  LEAD_UNCONTACTED: UncontactedEventPayload;
  FOLLOWUP_OVERDUE: OverdueEventPayload;
  STAGE_CHANGED: StageEventPayload;
}

// ── Plain-language descriptions (rule list, run log) ─────────────────────────

export function describeConditions(trigger: AutomationTriggerCode, raw: unknown): string {
  const parsed = conditionSchemas[trigger].safeParse(raw ?? {});
  if (!parsed.success) return 'Conditions need attention';
  const c = parsed.data as Record<string, unknown>;
  const parts: string[] = [];
  const hours = (m: number) => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);
  switch (trigger) {
    case 'WEB_LEAD_CREATED': {
      const statuses = c['statuses'] as string[] | undefined;
      if (statuses)
        parts.push(statuses.includes('DUPLICATE') ? 'new or repeat submissions' : 'new submissions only');
      if (c['sourceIds']) parts.push('from chosen sources');
      if (c['countries']) parts.push(`interested in ${(c['countries'] as string[]).join(' or ')}`);
      if (typeof c['minNeetScore'] === 'number') parts.push(`NEET score ${c['minNeetScore']} or more`);
      break;
    }
    case 'LEAD_UNCONTACTED':
      parts.push(
        typeof c['minutes'] === 'number'
          ? `after ${hours(c['minutes'])}`
          : 'after the workspace’s “uncontacted” time',
      );
      if (c['sourceIds']) parts.push('from chosen sources');
      break;
    case 'FOLLOWUP_OVERDUE':
      parts.push(
        `overdue by ${hours((c['minutesOverdue'] as number | undefined) ?? DEFAULT_OVERDUE_MINUTES)}`,
      );
      if (c['priority']) parts.push(`${String(c['priority']).toLowerCase()} priority`);
      break;
    case 'STAGE_CHANGED':
      parts.push(`changes to ${STAGE_LABEL[c['toStage'] as LeadStage]}`);
      if (c['fromStage']) parts.push(`from ${STAGE_LABEL[c['fromStage'] as LeadStage]}`);
      break;
  }
  return parts.join(', ');
}

export function describeAction(action: AutomationAction): string {
  switch (action.type) {
    case 'assign_round_robin':
      return `Assign a ${action.role === 'COUNSELOR' ? 'counselor' : 'telecaller'} in turn`;
    case 'notify':
      return `Notify ${NOTIFY_TARGET_LABEL[action.to].toLowerCase()}: “${action.title}”`;
    case 'escalate':
      return 'Escalate to the admins';
    case 'schedule_followup': {
      const m = action.afterMinutes;
      const after =
        m % 1440 === 0
          ? `${m / 1440} day${m === 1440 ? '' : 's'}`
          : m % 60 === 0
            ? `${m / 60} hour${m === 60 ? '' : 's'}`
            : `${m} minutes`;
      return `Schedule a call in ${after}`;
    }
    case 'stop_reminders':
      return 'Stop reminders';
  }
}
