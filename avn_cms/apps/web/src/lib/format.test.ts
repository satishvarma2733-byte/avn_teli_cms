import { describe, expect, it } from 'vitest';

import { formatDateTime, formatRelative, humanizeCode, readableSummary } from './format';

describe('readableSummary', () => {
  it('shows a stored ISO timestamp as a readable date and time', () => {
    const iso = '2026-10-19T15:25:00.000Z';
    expect(readableSummary(`Next call booked for ${iso}`)).toBe(
      `Next call booked for ${formatDateTime(iso)}`,
    );
    expect(readableSummary(`Call rescheduled to ${iso}`)).not.toContain('T15:25');
  });

  it('names the stage and call-outcome codes older lines were written with', () => {
    expect(readableSummary('Stage changed from NEW to FOLLOW_UP_REQUIRED')).toBe(
      'Stage changed from New to Follow-up required',
    );
    expect(readableSummary('Call logged: CALL_BACK_LATER')).toBe('Call logged: Call back later');
    expect(readableSummary('Call: NO_ANSWER — busy line')).toBe('Call: No answer — busy line');
  });

  it('names database fields in old contact-update lines', () => {
    expect(readableSummary('Contact details updated (phoneRaw, phoneE164, parentName)')).toBe(
      'Contact details updated (phone, parent’s name)',
    );
  });

  it('leaves current lines and text a person typed alone', () => {
    for (const s of [
      'Stage changed from New to Contacted — called twice',
      'Call: Interested — said NEW number, INTERESTED in MBBS',
      'Marked HOT',
      'Note: ask about NEET_SCORE tomorrow',
    ]) {
      expect(readableSummary(s)).toBe(s);
    }
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const day = 86_400_000;
  it('counts days up to two months, then months, then shows the date', () => {
    expect(formatRelative(ago(30_000), now)).toBe('just now');
    expect(formatRelative(ago(3 * day), now)).toBe('3 days ago');
    expect(formatRelative(ago(40 * day), now)).toBe('40 days ago');
    expect(formatRelative(ago(90 * day), now)).toBe('3 months ago');
    expect(formatRelative(new Date(now + 2 * day).toISOString(), now)).toBe('in 2 days');
    expect(formatRelative(ago(400 * day), now)).not.toMatch(/ago|months/);
  });
});

describe('humanizeCode', () => {
  it('turns a code into words', () => {
    expect(humanizeCode('TENANT_ADMIN')).toBe('Tenant admin');
    expect(humanizeCode('lead.assign')).toBe('Lead assign');
    expect(humanizeCode('COUNSELOR')).toBe('Counselor');
  });
});
