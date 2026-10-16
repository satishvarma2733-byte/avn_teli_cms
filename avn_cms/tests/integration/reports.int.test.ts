import { followups, leads, reports } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeAll, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

/** Phase 4 exit: funnel and source numbers reconcile against raw counts; counselors see only their own. */
describe('reports', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let c1: Awaited<ReturnType<typeof makeUser>>;
  let c2: Awaited<ReturnType<typeof makeUser>>;

  beforeAll(async () => {
    await resetData();
    tenant = await makeTenant('rep');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    c1 = await makeUser(tenant.id, 'COUNSELOR');
    c2 = await makeUser(tenant.id, 'COUNSELOR');
    // c1: 4 leads → one enrolled via the full path, one interested, one lost after contact, one new.
    const a = await makeLead(tenant.id, { counselorId: c1.id });
    const b = await makeLead(tenant.id, { counselorId: c1.id });
    const c = await makeLead(tenant.id, { counselorId: c1.id });
    await makeLead(tenant.id, { counselorId: c1.id });
    for (const s of [
      'CONTACTED',
      'INTERESTED',
      'APPLICATION_STARTED',
      'ADMISSION_CONFIRMED',
      'ENROLLED',
    ] as const) {
      await leads.updateLead(ctxFor(c1), a.lead.id, { stage: s });
    }
    await leads.updateLead(ctxFor(c1), b.lead.id, { stage: 'INTERESTED' }); // skipped CONTACTED
    await leads.updateLead(ctxFor(c1), c.lead.id, { stage: 'CONTACTED' });
    await leads.updateLead(ctxFor(c1), c.lead.id, { stage: 'LOST', lostReason: 'test' });
    // c2: 1 lead, enrolled directly.
    const d = await makeLead(tenant.id, { counselorId: c2.id });
    await leads.updateLead(ctxFor(c2), d.lead.id, { stage: 'ENROLLED' });
    // One logged call for c1.
    const { id } = await followups.schedule(ctxFor(c1), {
      leadId: b.lead.id,
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await followups.update(ctxFor(c1), id, { disposition: 'NO_ANSWER' });
  });

  it('funnel counts "reached at least" each stage from history + current stage', async () => {
    const f = await reports.funnel(ctxFor(admin), {});
    const at = (s: string) => f.find((x) => x.stage === s)!.count;
    expect(at('NEW')).toBe(5);
    expect(at('CONTACTED')).toBe(4); // a, b (skipped but went further), c, d (enrolled directly)
    expect(at('INTERESTED')).toBe(3); // a, b, d
    expect(at('ENROLLED')).toBe(2); // a, d
    // Reconcile with raw rows.
    expect(at('NEW')).toBe(await ownerDb().lead.count({ where: { tenantId: tenant.id } }));
    expect(at('ENROLLED')).toBe(
      await ownerDb().lead.count({ where: { tenantId: tenant.id, stage: 'ENROLLED' } }),
    );
  });

  it('sources and stage distribution add up to the lead total', async () => {
    const s = await reports.sources(ctxFor(admin), {});
    expect(s.reduce((a, b) => a + b.leads, 0)).toBe(5);
    expect(s.reduce((a, b) => a + b.enrolled, 0)).toBe(2);
    const dist = await reports.stageDistribution(ctxFor(admin), {});
    expect(dist.reduce((a, b) => a + b.count, 0)).toBe(5);
  });

  it('team report: conversion per counselor; a counselor sees only themselves', async () => {
    const t = await reports.team(ctxFor(admin), {});
    const r1 = t.find((r) => r.userId === c1.id)!;
    const r2 = t.find((r) => r.userId === c2.id)!;
    expect(r1).toMatchObject({ leads: 4, enrolled: 1, conversionPct: 25, calls: 1, noAnswerPct: 100 });
    expect(r2).toMatchObject({ leads: 1, enrolled: 1, conversionPct: 100 });
    const own = await reports.team(ctxFor(c1), {});
    expect(own.map((r) => r.userId)).toEqual([c1.id]);
    // A counselor can't widen the scope by passing someone else's id.
    expect((await reports.team(ctxFor(c1), { assigneeId: c2.id })).map((r) => r.userId)).toEqual([c1.id]);
    expect((await reports.funnel(ctxFor(c1), {})).find((x) => x.stage === 'NEW')!.count).toBe(4);
  });

  it('dashboard cards come from real rows, scoped by role', async () => {
    const adminDash = await reports.dashboard(ctxFor(admin));
    expect(adminDash.cards.enrolled).toBe(2);
    expect(adminDash.cards.activeLeads).toBe(2); // b (interested) + the NEW one
    const c2Dash = await reports.dashboard(ctxFor(c2));
    expect(c2Dash.cards).toMatchObject({ enrolled: 1, activeLeads: 0 });
  });

  it('telecallers cannot open the tenant reports', async () => {
    const t = await makeUser(tenant.id, 'TELECALLER');
    const own = await reports.team(ctxFor(t), {});
    expect(own.map((r) => r.userId)).toEqual([t.id]);
  });
});
