import { describe, expect, it } from 'vitest';

import type {
  EventPayloads,
  OverdueEventPayload,
  StageEventPayload,
  WebLeadEventPayload,
} from './definitions';
import { ruleMatches } from './match';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-4222-8222-222222222222';

const webLead = (over: Partial<WebLeadEventPayload> = {}): WebLeadEventPayload => ({
  webLeadId: 'w1',
  name: 'Asha',
  status: 'NEW',
  sourceId: SOURCE,
  country: 'Russia',
  neetScore: 500,
  ...over,
});
const stage = (over: Partial<StageEventPayload> = {}): StageEventPayload => ({
  leadId: 'l1',
  studentId: 's1',
  name: 'Asha',
  sourceId: SOURCE,
  from: 'CONTACTED',
  to: 'INTERESTED',
  ...over,
});
const overdue = (over: Partial<OverdueEventPayload> = {}): OverdueEventPayload => ({
  followUpId: 'f1',
  leadId: 'l1',
  studentId: 's1',
  name: 'Asha',
  sourceId: SOURCE,
  assigneeId: 'u1',
  priority: 'NORMAL',
  scheduledAt: '2026-10-15T09:00:00.000Z',
  minutesOverdue: 1500,
  ...over,
});

describe('web lead rules', () => {
  const match = (conditions: unknown, over?: Partial<WebLeadEventPayload>) =>
    ruleMatches('WEB_LEAD_CREATED', conditions, webLead(over));

  it('match everything when there are no conditions', () => {
    expect(match({})).toBe(true);
    expect(match(null)).toBe(true);
    expect(match(undefined, { sourceId: null, country: null, neetScore: null })).toBe(true);
  });

  it('can be limited to new or to repeat submissions', () => {
    expect(match({ statuses: ['NEW'] })).toBe(true);
    expect(match({ statuses: ['NEW'] }, { status: 'DUPLICATE' })).toBe(false);
    expect(match({ statuses: ['DUPLICATE'] }, { status: 'DUPLICATE' })).toBe(true);
  });

  it('can be limited to some sources, and a lead with no source is not in them', () => {
    expect(match({ sourceIds: [SOURCE] })).toBe(true);
    expect(match({ sourceIds: [OTHER_SOURCE] })).toBe(false);
    expect(match({ sourceIds: [SOURCE] }, { sourceId: null })).toBe(false);
  });

  it('compare countries without minding case or spaces', () => {
    expect(match({ countries: ['russia'] })).toBe(true);
    expect(match({ countries: [' RUSSIA '] })).toBe(true);
    expect(match({ countries: ['Georgia'] })).toBe(false);
    expect(match({ countries: ['Russia'] }, { country: null })).toBe(false);
  });

  it('need a NEET score that reaches the minimum, and no score does not reach it', () => {
    expect(match({ minNeetScore: 500 })).toBe(true);
    expect(match({ minNeetScore: 501 })).toBe(false);
    expect(match({ minNeetScore: 0 }, { neetScore: null })).toBe(false);
  });

  it('need every condition to hold', () => {
    expect(match({ statuses: ['NEW'], countries: ['Russia'], minNeetScore: 400 })).toBe(true);
    expect(match({ statuses: ['NEW'], countries: ['Georgia'], minNeetScore: 400 })).toBe(false);
  });
});

describe('uncontacted lead rules', () => {
  const payload: EventPayloads['LEAD_UNCONTACTED'] = {
    leadId: 'l1',
    studentId: 's1',
    name: 'Asha',
    sourceId: SOURCE,
    minutes: 30,
  };
  it('look only at the source (the sweep applies the waiting time)', () => {
    expect(ruleMatches('LEAD_UNCONTACTED', { minutes: 30 }, payload)).toBe(true);
    expect(ruleMatches('LEAD_UNCONTACTED', { sourceIds: [SOURCE] }, payload)).toBe(true);
    expect(ruleMatches('LEAD_UNCONTACTED', { sourceIds: [OTHER_SOURCE] }, payload)).toBe(false);
    expect(ruleMatches('LEAD_UNCONTACTED', { sourceIds: [SOURCE] }, { ...payload, sourceId: null })).toBe(
      false,
    );
  });
});

describe('overdue call rules', () => {
  it('can be limited to hot calls', () => {
    expect(ruleMatches('FOLLOWUP_OVERDUE', {}, overdue())).toBe(true);
    expect(ruleMatches('FOLLOWUP_OVERDUE', { priority: 'HOT' }, overdue())).toBe(false);
    expect(ruleMatches('FOLLOWUP_OVERDUE', { priority: 'HOT' }, overdue({ priority: 'HOT' }))).toBe(true);
  });
});

describe('stage change rules', () => {
  it('fire only for the stage they name', () => {
    expect(ruleMatches('STAGE_CHANGED', { toStage: 'INTERESTED' }, stage())).toBe(true);
    expect(ruleMatches('STAGE_CHANGED', { toStage: 'ENROLLED' }, stage())).toBe(false);
  });

  it('can also require where the lead came from', () => {
    expect(ruleMatches('STAGE_CHANGED', { toStage: 'INTERESTED', fromStage: 'CONTACTED' }, stage())).toBe(
      true,
    );
    expect(ruleMatches('STAGE_CHANGED', { toStage: 'INTERESTED', fromStage: 'NEW' }, stage())).toBe(false);
    expect(
      ruleMatches('STAGE_CHANGED', { toStage: 'INTERESTED', fromStage: 'NEW' }, stage({ from: 'NEW' })),
    ).toBe(true);
  });
});

describe('conditions that no longer parse', () => {
  it('never fire: doing nothing is safer than guessing', () => {
    expect(ruleMatches('STAGE_CHANGED', {}, stage())).toBe(false); // no stage named
    expect(ruleMatches('STAGE_CHANGED', { toStage: 'NOT_A_STAGE' }, stage({ to: 'NEW' }))).toBe(false);
    expect(ruleMatches('WEB_LEAD_CREATED', { minNeetScore: 'high' }, webLead())).toBe(false);
    expect(ruleMatches('WEB_LEAD_CREATED', { surprise: true }, webLead())).toBe(false);
    expect(ruleMatches('FOLLOWUP_OVERDUE', { priority: 'URGENT' }, overdue())).toBe(false);
  });
});
