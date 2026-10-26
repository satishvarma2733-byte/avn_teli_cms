import { resetConfigForTests } from '@avn-cms/config';
import { clearCacheForTests, reports } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

/**
 * The dashboard and report queries written for big workspaces (docs/SCALABILITY.md): the same numbers as
 * the straightforward versions gave, from the rows, and a cache that cannot show one person another's.
 */
describe('reports for big workspaces', () => {
  let tenant: { id: string };
  let other: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let otherAdmin: Awaited<ReturnType<typeof makeUser>>;
  let c1: Awaited<ReturnType<typeof makeUser>>;
  let c2: Awaited<ReturnType<typeof makeUser>>;
  let leadA: Awaited<ReturnType<typeof makeLead>>;

  const DAY = 86_400_000;
  const newCount = (f: { stage: string; count: number }[]) => f.find((x) => x.stage === 'NEW')!.count;

  beforeAll(async () => {
    await resetData();
    tenant = await makeTenant('rep-big');
    other = await makeTenant('rep-other');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    otherAdmin = await makeUser(other.id, 'TENANT_ADMIN');
    c1 = await makeUser(tenant.id, 'COUNSELOR');
    c2 = await makeUser(tenant.id, 'COUNSELOR');
    leadA = await makeLead(tenant.id, { counselorId: c1.id });
    await makeLead(tenant.id, { counselorId: c1.id });
    await makeLead(tenant.id, { counselorId: c2.id, stage: 'ENROLLED' });
    await makeLead(other.id);

    const db = ownerDb();
    const call = (data: {
      scheduledAt: Date;
      completedAt?: Date;
      disposition?: 'CALL_BACK_LATER' | 'NO_ANSWER' | 'COMPLETED';
    }) =>
      db.followUp.create({
        data: { tenantId: tenant.id, leadId: leadA.lead.id, assigneeId: c1.id, ...data },
      });
    // An old call nobody made (overdue), on a lead that earlier asked to be called back.
    await call({ scheduledAt: new Date(Date.now() - 3 * DAY) });
    await call({
      scheduledAt: new Date(Date.now() - 5 * DAY),
      completedAt: new Date(Date.now() - 4 * DAY),
      disposition: 'CALL_BACK_LATER',
    });
    // A call that got no answer a minute ago, and a finished one from a month ago (outside the week).
    await call({
      scheduledAt: new Date(Date.now() - 3_600_000),
      completedAt: new Date(Date.now() - 60_000),
      disposition: 'NO_ANSWER',
    });
    await call({
      scheduledAt: new Date(Date.now() - 31 * DAY),
      completedAt: new Date(Date.now() - 30 * DAY),
      disposition: 'COMPLETED',
    });
  });

  afterEach(() => {
    process.env['REPORT_CACHE_SECONDS'] = '0';
    resetConfigForTests();
    clearCacheForTests();
  });

  it('dashboard cards: every number from the two passes matches the rows', async () => {
    const adminDash = await reports.dashboard(ctxFor(admin));
    expect(adminDash.cards).toMatchObject({
      activeLeads: 2, // c1's two leads; the enrolled one is closed
      enrolled: 1,
      newUncontacted: 2,
      overdue: 1,
      callsToday: 0,
      completedToday: 1,
      callbacksDue: 1, // the open call is on a lead that once asked to be called back
      noAnswerRate7d: 50, // two calls logged this week, one with no answer
    });
    const c1Dash = await reports.dashboard(ctxFor(c1));
    expect(c1Dash.cards).toMatchObject({
      activeLeads: 2,
      enrolled: 0,
      overdue: 1,
      completedToday: 1,
      callbacksDue: 1,
    });
    const c2Dash = await reports.dashboard(ctxFor(c2));
    expect(c2Dash.cards).toMatchObject({
      activeLeads: 0,
      enrolled: 1,
      overdue: 0,
      completedToday: 0,
      callbacksDue: 0,
      noAnswerRate7d: null,
    });
    // Nobody sees another agency's rows.
    expect((await reports.dashboard(ctxFor(otherAdmin))).cards).toMatchObject({ activeLeads: 1, overdue: 0 });
  });

  it('dashboard is plain JSON, so it can be kept in Redis', async () => {
    const dash = await reports.dashboard(ctxFor(admin));
    expect(JSON.parse(JSON.stringify(dash))).toEqual(dash);
    expect(dash.queue).toHaveLength(1);
    expect(typeof dash.queue[0]!.scheduledAt).toBe('string');
  });

  it('the funnel reads the same whether it covers the whole workspace or a filtered part of it', async () => {
    const whole = await reports.funnel(ctxFor(admin), {});
    const filtered = await reports.funnel(ctxFor(admin), { dateFrom: '2000-01-01' });
    expect(filtered).toEqual(whole);
    expect(newCount(whole)).toBe(3);
    // One counselor's, asked for by the admin and by themselves.
    const asAdmin = await reports.funnel(ctxFor(admin), { assigneeId: c1.id });
    const asSelf = await reports.funnel(ctxFor(c1), {});
    expect(asAdmin).toEqual(asSelf);
    expect(newCount(asSelf)).toBe(2);
  });

  it('the follow-up report counts open, overdue and logged calls from the rows', async () => {
    const all = await reports.followupStats(ctxFor(admin), {});
    expect(all).toMatchObject({ open: 1, overdue: 1, escalated: 0, logged: 3 });
    expect(all.byDisposition.map((d) => d.disposition).sort()).toEqual([
      'CALL_BACK_LATER',
      'COMPLETED',
      'NO_ANSWER',
    ]);
    const weekAgo = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
    expect((await reports.followupStats(ctxFor(admin), { dateFrom: weekAgo })).logged).toBe(2);
    expect(await reports.followupStats(ctxFor(c2), {})).toMatchObject({ open: 0, logged: 0 });
  });

  describe('the cache', () => {
    const turnOn = () => {
      process.env['REPORT_CACHE_SECONDS'] = '60';
      resetConfigForTests();
      clearCacheForTests();
    };

    it('reuses an answer for the same workspace and scope, and never across workspaces or people', async () => {
      turnOn();
      const before = await reports.funnel(ctxFor(admin), {});
      const mineBefore = await reports.funnel(ctxFor(c1), {});
      expect(newCount(before)).toBe(3);
      expect(newCount(mineBefore)).toBe(2);
      expect(newCount(await reports.funnel(ctxFor(otherAdmin), {}))).toBe(1);

      await makeLead(tenant.id, { counselorId: c1.id });
      expect(await reports.funnel(ctxFor(admin), {})).toEqual(before); // still the minute-old answer
      expect(await reports.funnel(ctxFor(c1), {})).toEqual(mineBefore);

      clearCacheForTests();
      expect(newCount(await reports.funnel(ctxFor(admin), {}))).toBe(4);
      expect(newCount(await reports.funnel(ctxFor(c1), {}))).toBe(3);
      expect(newCount(await reports.funnel(ctxFor(otherAdmin), {}))).toBe(1);
    });

    it('keeps different filters apart', async () => {
      turnOn();
      const all = await reports.sources(ctxFor(admin), {});
      const none = await reports.sources(ctxFor(admin), { dateTo: '2000-01-01' });
      expect(all.length).toBeGreaterThan(0);
      expect(none).toEqual([]);
    });

    it('never holds back a person’s own cards', async () => {
      turnOn();
      const before = await reports.dashboard(ctxFor(c1));
      await makeLead(tenant.id, { counselorId: c1.id });
      const after = await reports.dashboard(ctxFor(c1));
      expect(after.cards.activeLeads).toBe(before.cards.activeLeads + 1);
    });
  });
});
