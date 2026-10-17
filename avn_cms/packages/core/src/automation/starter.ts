import type { AutomationAction, AutomationTriggerCode } from './definitions';

/**
 * The rules every workspace is offered (and every new workspace starts with). They are ordinary
 * rules: an admin can switch them off or change them. The key identifies a starter rule, so
 * installing twice never duplicates one.
 */
export interface StarterRule {
  key: string;
  name: string;
  trigger: AutomationTriggerCode;
  conditions: Record<string, unknown>;
  actions: AutomationAction[];
}

export const STARTER_RULES: readonly StarterRule[] = [
  {
    key: 'route_web_leads',
    name: 'Route new web leads to a counselor',
    trigger: 'WEB_LEAD_CREATED',
    conditions: { statuses: ['NEW'] },
    actions: [
      { type: 'assign_round_robin', role: 'COUNSELOR' },
      {
        type: 'notify',
        to: 'assigned',
        title: 'New web lead: {name}',
        body: 'A website enquiry was routed to you. Open Web leads to review it.',
      },
    ],
  },
  {
    key: 'uncontacted_notify',
    name: 'Tell the admins about leads nobody has contacted',
    trigger: 'LEAD_UNCONTACTED',
    conditions: {},
    actions: [
      {
        type: 'notify',
        to: 'admins',
        title: 'Not contacted yet: {name}',
        body: 'This lead has been waiting {minutes} minutes without a call.',
      },
    ],
  },
  {
    key: 'escalate_overdue',
    name: 'Escalate calls that are 24 hours overdue',
    trigger: 'FOLLOWUP_OVERDUE',
    conditions: { minutesOverdue: 1440 },
    actions: [{ type: 'escalate' }],
  },
  {
    key: 'interested_schedule',
    name: 'Schedule a call when a lead becomes Interested',
    trigger: 'STAGE_CHANGED',
    conditions: { toStage: 'INTERESTED' },
    actions: [{ type: 'schedule_followup', afterMinutes: 1440, assignee: 'owner' }],
  },
  {
    key: 'enrolled_stop',
    name: 'Stop reminders once a student is enrolled',
    trigger: 'STAGE_CHANGED',
    conditions: { toStage: 'ENROLLED' },
    actions: [{ type: 'stop_reminders' }],
  },
];

/** Rows for `automationRule.createMany` (owner client or scoped client) for the given starters. */
export function starterRuleRows(tenantId: string, createdById: string | null, keys?: readonly string[]) {
  return STARTER_RULES.filter((r) => !keys || keys.includes(r.key)).map((r) => ({
    tenantId,
    name: r.name,
    isActive: true,
    trigger: r.trigger,
    conditions: r.conditions,
    actions: r.actions,
    starterKey: r.key,
    createdById,
  }));
}
