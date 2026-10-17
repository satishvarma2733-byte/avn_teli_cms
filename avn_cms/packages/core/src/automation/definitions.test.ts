import { describe, expect, it } from 'vitest';

import {
  actionSchema,
  conditionSchemas,
  describeAction,
  describeConditions,
  MAX_ACTIONS,
  rulePatchSchema,
  runListQuerySchema,
  ruleInputSchema,
} from './definitions';
import { STARTER_RULES } from './starter';

const notifyAdmins = { type: 'notify', to: 'admins', title: 'Hello {name}' } as const;
const rule = (over: Record<string, unknown> = {}) => ({
  name: 'A rule',
  trigger: 'WEB_LEAD_CREATED',
  conditions: {},
  actions: [notifyAdmins],
  ...over,
});
const problems = (input: unknown): string[] => {
  const parsed = ruleInputSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'));
};

describe('ruleInputSchema', () => {
  it('accepts a complete rule and switches it on by default', () => {
    const parsed = ruleInputSchema.parse(rule());
    expect(parsed).toMatchObject({ name: 'A rule', isActive: true, trigger: 'WEB_LEAD_CREATED' });
  });

  it('needs a name and at least one action, and caps both', () => {
    expect(problems(rule({ name: '   ' }))).toContain('name');
    expect(problems(rule({ actions: [] }))).toContain('actions');
    expect(
      problems(rule({ actions: Array.from({ length: MAX_ACTIONS + 1 }, () => notifyAdmins) })),
    ).toContain('actions');
    expect(problems(rule({ name: 'x'.repeat(101) }))).toContain('name');
  });

  it('points at the condition that is wrong', () => {
    expect(problems(rule({ trigger: 'LEAD_UNCONTACTED', conditions: { minutes: 1 } }))).toContain(
      'conditions.minutes',
    );
    expect(problems(rule({ trigger: 'FOLLOWUP_OVERDUE', conditions: { minutesOverdue: 99_999 } }))).toContain(
      'conditions.minutesOverdue',
    );
    // A stage change needs to say which stage.
    expect(problems(rule({ trigger: 'STAGE_CHANGED', conditions: {} }))).toContain('conditions.toStage');
    // Unknown conditions are mistakes, not extras.
    expect(problems(rule({ conditions: { minuts: 30 } }))).not.toEqual([]);
  });

  it('only allows actions that make sense after the trigger', () => {
    // A web lead has no calls to escalate or reminders to stop.
    expect(problems(rule({ actions: [{ type: 'escalate' }] }))).toContain('actions.0.type');
    expect(problems(rule({ actions: [{ type: 'stop_reminders' }] }))).toContain('actions.0.type');
    // A call that is overdue is not assigned to anyone new.
    expect(
      problems(
        rule({ trigger: 'FOLLOWUP_OVERDUE', actions: [{ type: 'assign_round_robin', role: 'COUNSELOR' }] }),
      ),
    ).toContain('actions.0.type');
    expect(problems(rule({ trigger: 'FOLLOWUP_OVERDUE', actions: [{ type: 'escalate' }] }))).toEqual([]);
  });

  it('only allows people the trigger can name', () => {
    // A web lead has no counselor yet; only whoever the rule routed it to can be told.
    expect(problems(rule({ actions: [{ ...notifyAdmins, to: 'counselor' }] }))).toContain('actions.0.to');
    expect(problems(rule({ actions: [{ ...notifyAdmins, to: 'assigned' }] }))).toEqual([]);
    expect(problems(rule({ actions: [{ type: 'assign_round_robin', role: 'TELECALLER' }] }))).toContain(
      'actions.0.role',
    );
    expect(
      problems(
        rule({
          trigger: 'LEAD_UNCONTACTED',
          actions: [{ type: 'assign_round_robin', role: 'TELECALLER' }],
        }),
      ),
    ).toEqual([]);
  });
});

describe('actionSchema', () => {
  it('requires a title for a notification and refuses stray fields', () => {
    expect(actionSchema.safeParse({ type: 'notify', to: 'admins', title: ' ' }).success).toBe(false);
    expect(actionSchema.safeParse({ ...notifyAdmins, extra: 1 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'escalate', extra: 1 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it('keeps a follow-up between 5 minutes and 30 days away', () => {
    const call = (afterMinutes: number) =>
      actionSchema.safeParse({ type: 'schedule_followup', afterMinutes, assignee: 'owner' }).success;
    expect([call(4), call(5), call(43_200), call(43_201), call(90.5)]).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('rulePatchSchema and runListQuerySchema', () => {
  it('lets a patch carry any part of a rule', () => {
    expect(rulePatchSchema.parse({})).toEqual({});
    expect(rulePatchSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(rulePatchSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('pages the run log with sane bounds', () => {
    expect(runListQuerySchema.parse({})).toMatchObject({ limit: 50 });
    expect(runListQuerySchema.parse({ limit: '10', status: 'FAILED' })).toMatchObject({
      limit: 10,
      status: 'FAILED',
    });
    expect(runListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(runListQuerySchema.safeParse({ ruleId: 'nope' }).success).toBe(false);
  });
});

describe('describing a rule in plain words', () => {
  it('says what a trigger waits for', () => {
    expect(describeConditions('WEB_LEAD_CREATED', {})).toBe('');
    expect(describeConditions('WEB_LEAD_CREATED', { statuses: ['NEW'] })).toBe('new submissions only');
    expect(describeConditions('WEB_LEAD_CREATED', { statuses: ['NEW', 'DUPLICATE'] })).toBe(
      'new or repeat submissions',
    );
    expect(
      describeConditions('WEB_LEAD_CREATED', { countries: ['Russia', 'Georgia'], minNeetScore: 400 }),
    ).toBe('interested in Russia or Georgia, NEET score 400 or more');
    expect(describeConditions('LEAD_UNCONTACTED', { minutes: 90 })).toBe('after 90 minutes');
    expect(describeConditions('LEAD_UNCONTACTED', { minutes: 120 })).toBe('after 2 hours');
    expect(describeConditions('LEAD_UNCONTACTED', {})).toBe('after the workspace’s “uncontacted” time');
    expect(describeConditions('FOLLOWUP_OVERDUE', {})).toBe('overdue by 24 hours');
    expect(describeConditions('FOLLOWUP_OVERDUE', { minutesOverdue: 60, priority: 'HOT' })).toBe(
      'overdue by 1 hour, hot priority',
    );
    expect(describeConditions('STAGE_CHANGED', { toStage: 'INTERESTED' })).toBe('changes to Interested');
    expect(describeConditions('STAGE_CHANGED', { toStage: 'ENROLLED', fromStage: 'POTENTIAL' })).toBe(
      'changes to Enrolled, from Potential',
    );
  });

  it('does not guess when stored conditions are broken', () => {
    expect(describeConditions('STAGE_CHANGED', { toStage: 'NOPE' })).toBe('Conditions need attention');
  });

  it('says what an action does', () => {
    expect(describeAction({ type: 'assign_round_robin', role: 'COUNSELOR' })).toBe(
      'Assign a counselor in turn',
    );
    expect(describeAction({ type: 'assign_round_robin', role: 'TELECALLER' })).toBe(
      'Assign a telecaller in turn',
    );
    expect(describeAction(notifyAdmins)).toBe('Notify the admins: “Hello {name}”');
    expect(describeAction({ type: 'escalate' })).toBe('Escalate to the admins');
    expect(describeAction({ type: 'stop_reminders' })).toBe('Stop reminders');
    expect(describeAction({ type: 'schedule_followup', afterMinutes: 1440, assignee: 'owner' })).toBe(
      'Schedule a call in 1 day',
    );
    expect(describeAction({ type: 'schedule_followup', afterMinutes: 180, assignee: 'owner' })).toBe(
      'Schedule a call in 3 hours',
    );
    expect(describeAction({ type: 'schedule_followup', afterMinutes: 45, assignee: 'owner' })).toBe(
      'Schedule a call in 45 minutes',
    );
  });
});

describe('the starter rules', () => {
  it('are all valid rules, with distinct keys and names', () => {
    for (const starter of STARTER_RULES) {
      expect(problems({ ...starter, actions: starter.actions }), starter.key).toEqual([]);
      expect(conditionSchemas[starter.trigger].safeParse(starter.conditions).success, starter.key).toBe(true);
    }
    expect(new Set(STARTER_RULES.map((r) => r.key)).size).toBe(STARTER_RULES.length);
    expect(new Set(STARTER_RULES.map((r) => r.name)).size).toBe(STARTER_RULES.length);
  });

  it('cover the five jobs promised in the plan', () => {
    expect(STARTER_RULES.map((r) => [r.trigger, r.actions.map((a) => a.type)])).toEqual([
      ['WEB_LEAD_CREATED', ['assign_round_robin', 'notify']],
      ['LEAD_UNCONTACTED', ['notify']],
      ['FOLLOWUP_OVERDUE', ['escalate']],
      ['STAGE_CHANGED', ['schedule_followup']],
      ['STAGE_CHANGED', ['stop_reminders']],
    ]);
  });
});
