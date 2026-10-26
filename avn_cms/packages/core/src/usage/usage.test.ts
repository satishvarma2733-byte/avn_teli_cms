import { describe, expect, it } from 'vitest';

import { monthOf, parsePlanLimits, USAGE_METRICS } from './usage.service';

describe('parsePlanLimits', () => {
  it('reads the three limits, turning storage into bytes', () => {
    expect(parsePlanLimits({ max_users: 15, max_leads: 50_000, storage_mb: 10_240 })).toEqual({
      users: 15,
      leads: 50_000,
      storageBytes: 10_240 * 1024 * 1024,
    });
  });

  it('treats a missing or null limit as no limit', () => {
    expect(parsePlanLimits({})).toEqual({ users: null, leads: null, storageBytes: null });
    expect(parsePlanLimits({ max_users: null, max_leads: null, storage_mb: null })).toEqual({
      users: null,
      leads: null,
      storageBytes: null,
    });
    expect(parsePlanLimits({ max_users: 3 })).toEqual({ users: 3, leads: null, storageBytes: null });
  });

  it('keeps zero as a real limit (nothing may be added), not as "no limit"', () => {
    expect(parsePlanLimits({ max_leads: 0 }).leads).toBe(0);
  });

  it('ignores anything that is not a non-negative number, rather than guessing', () => {
    expect(parsePlanLimits({ max_users: '15', max_leads: -1, storage_mb: Number.NaN })).toEqual({
      users: null,
      leads: null,
      storageBytes: null,
    });
    expect(parsePlanLimits({ max_users: Number.POSITIVE_INFINITY }).users).toBeNull();
  });

  it('copes with a plan that has no limits object at all', () => {
    for (const raw of [null, undefined, 'unlimited', 42, []]) {
      expect(parsePlanLimits(raw)).toEqual({ users: null, leads: null, storageBytes: null });
    }
  });
});

describe('monthOf', () => {
  it('names the month in UTC and starts it at midnight on the 1st', () => {
    const { start, period } = monthOf(new Date('2026-10-17T11:02:36Z'));
    expect(period).toBe('2026-10');
    expect(start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('pads single-digit months and rolls over the year', () => {
    expect(monthOf(new Date('2027-01-31T23:59:59Z')).period).toBe('2027-01');
    expect(monthOf(new Date('2026-12-01T00:00:00Z')).period).toBe('2026-12');
  });

  it('uses UTC, not the machine’s zone, at the edge of a month', () => {
    expect(monthOf(new Date('2026-10-31T23:30:00Z')).period).toBe('2026-10');
    expect(monthOf(new Date('2026-11-01T00:00:00Z')).period).toBe('2026-11');
  });
});

describe('the metered quantities', () => {
  it('are the four a billing system reads', () => {
    expect([...USAGE_METRICS]).toEqual(['users', 'leads', 'storage_bytes', 'automation_runs']);
  });
});
