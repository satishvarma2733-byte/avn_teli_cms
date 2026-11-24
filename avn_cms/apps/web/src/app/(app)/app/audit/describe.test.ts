import { describe, expect, it } from 'vitest';

import { actionLabel, describeChanges, entityLabel, formatValue, leadLink } from './describe';

const LEAD = '9e097ff5-e240-4e04-b1f5-4b593daecc80';

describe('audit rows in plain words', () => {
  it('names every action and record type, and falls back to words for new ones', () => {
    expect(actionLabel('lead.stage_change')).toBe('Stage changed');
    expect(actionLabel('auth.mfa_reset_by_admin')).toBe('Two-step verification reset by an admin');
    expect(actionLabel('something.brand_new')).toBe('Something brand new');
    expect(entityLabel('follow_up')).toBe('Call');
    expect(entityLabel('mystery_thing')).toBe('Mystery thing');
  });

  it('shows only the fields that changed, with their labels', () => {
    // lead.update stores a snapshot of several fields before, and only what changed after.
    expect(
      describeChanges(
        { priority: 'HOT', isPotential: false, interestCountry: 'Uzbekistan' },
        { priority: 'NORMAL' },
      ),
    ).toEqual([{ field: 'Priority', from: 'Hot', to: 'Normal' }]);
    expect(
      describeChanges({ name: 'Escalate', isActive: false }, { name: 'Escalate', isActive: true }),
    ).toEqual([{ field: 'On', from: 'No', to: 'Yes' }]);
  });

  it('uses the product’s names for stages and call outcomes', () => {
    expect(describeChanges({ stage: 'CONTACTED' }, { stage: 'INTERESTED', note: 'After call' })).toEqual([
      { field: 'Stage', from: 'Contacted', to: 'Interested' },
      { field: 'Note', to: 'After call' },
    ]);
    expect(describeChanges({ disposition: 'SCHEDULED' }, { disposition: 'NO_ANSWER' })).toEqual([
      { field: 'Outcome', from: 'Scheduled', to: 'No answer' },
    ]);
  });

  it('keeps machine ids out of the summary and links to the student when it can', () => {
    expect(describeChanges(null, { leadId: LEAD, studentId: LEAD })).toEqual([]);
    expect(leadLink({ entityType: 'note', entityId: 'x', oldValue: null, newValue: { leadId: LEAD } })).toBe(
      `/app/leads/${LEAD}`,
    );
    expect(leadLink({ entityType: 'lead', entityId: LEAD, oldValue: null, newValue: null })).toBe(
      `/app/leads/${LEAD}`,
    );
    expect(leadLink({ entityType: 'user', entityId: LEAD, oldValue: null, newValue: null })).toBeNull();
  });

  it('formats values people read', () => {
    expect(formatValue('sizeBytes', 36082)).toBe('35 KB');
    expect(formatValue('x', null)).toBe('—');
    expect(formatValue('roleCode', 'TENANT_ADMIN')).toBe('Admin');
    expect(formatValue('student', { id: LEAD, name: 'Asha Rao' })).toBe('Asha Rao');
    expect(formatValue('id', LEAD)).toBe('#9e097ff5');
    expect(formatValue('scheduledAt', '2026-10-19T15:25:00.000Z')).not.toContain('T15');
  });
});
