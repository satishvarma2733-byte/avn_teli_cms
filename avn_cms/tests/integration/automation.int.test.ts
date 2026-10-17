import {
  AppError,
  automation,
  leads,
  notifications,
  runAutomation,
  sweepAutomation,
  webLeads,
} from '@avn-cms/core';
import { MAX_RULES } from '@avn-cms/core/automation';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FollowupService from '../../packages/core/src/followups/followup.service';
import { ctxFor } from '../fixtures/ctx';
import {
  makeLead,
  makeTenant,
  makeUser,
  resetData,
  webLeadSubmission as submission,
} from '../fixtures/factory';

// A way to make one step of a run fail on demand, to prove a run is all-or-nothing.
vi.mock('../../packages/core/src/followups/followup.service', async (importOriginal) => {
  const actual = await importOriginal<typeof FollowupService>();
  return { ...actual, recomputeNextCall: vi.fn(actual.recomputeNextCall) };
});
import { recomputeNextCall } from '../../packages/core/src/followups/followup.service';

/**
 * The rule engine on the real database: every starter rule fires, a rule that is off never runs,
 * runs are all-or-nothing and retried, nothing crosses workspaces, and nothing is lost when a
 * worker dies. Jobs run inline here (no Redis), right after the change commits.
 */
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};

const hours = (n: number) => new Date(Date.now() - n * 3_600_000);

describe('automation', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let c1: Awaited<ReturnType<typeof makeUser>>;
  let c2: Awaited<ReturnType<typeof makeUser>>;
  let t1: Awaited<ReturnType<typeof makeUser>>;
  let adminCtx: ReturnType<typeof ctxFor>;

  beforeEach(async () => {
    vi.mocked(recomputeNextCall).mockClear();
    await resetData();
    tenant = await makeTenant('auto');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    c1 = await makeUser(tenant.id, 'COUNSELOR');
    c2 = await makeUser(tenant.id, 'COUNSELOR');
    t1 = await makeUser(tenant.id, 'TELECALLER');
    adminCtx = ctxFor(admin);
  });

  const runs = () =>
    ownerDb().automationRun.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'asc' },
      include: { rule: true },
    });
  const notesFor = (userId: string) =>
    ownerDb().notification.findMany({ where: { tenantId: tenant.id, userId } });
  const ingest = async (over: Record<string, unknown> = {}) =>
    webLeads.ingest({
      tenantId: tenant.id,
      credentialId: null,
      defaultSourceId: null,
      channel: 'PUBLIC_API',
      dto: submission(over) as never,
      rawPayload: {},
    });
  const ruleByKey = async (key: string) =>
    ownerDb().automationRule.findFirstOrThrow({ where: { tenantId: tenant.id, starterKey: key } });

  // ── Managing rules ─────────────────────────────────────────────────────────

  describe('managing rules', () => {
    it('validates a rule as a whole and says which part is wrong', async () => {
      const bad = async (rule: Record<string, unknown>) => {
        try {
          await automation.createRule(adminCtx, rule);
          return null;
        } catch (e) {
          return e instanceof AppError
            ? ((e.details as { fields: Record<string, string> }).fields ?? {})
            : null;
        }
      };
      // An action that doesn't fit the trigger (a web lead has no calls to stop).
      expect(
        await bad({
          name: 'x',
          trigger: 'WEB_LEAD_CREATED',
          conditions: {},
          actions: [{ type: 'stop_reminders' }],
        }),
      ).toHaveProperty(['actions.0.type']);
      // A stage rule needs the stage it waits for.
      expect(
        await bad({
          name: 'x',
          trigger: 'STAGE_CHANGED',
          conditions: {},
          actions: [{ type: 'stop_reminders' }],
        }),
      ).toHaveProperty(['conditions.toStage']);
      // Unknown conditions are refused rather than ignored (a typo would otherwise match everything).
      expect(
        await bad({
          name: 'x',
          trigger: 'LEAD_UNCONTACTED',
          conditions: { minuts: 30 },
          actions: [{ type: 'notify', to: 'admins', title: 'Hi' }],
        }),
      ).toBeTruthy();
      // Too early, too many actions, a notify target that doesn't exist for the trigger, a web lead to a telecaller.
      expect(
        await bad({
          name: 'x',
          trigger: 'LEAD_UNCONTACTED',
          conditions: { minutes: 1 },
          actions: [{ type: 'notify', to: 'admins', title: 'Hi' }],
        }),
      ).toHaveProperty(['conditions.minutes']);
      expect(
        await bad({
          name: 'x',
          trigger: 'WEB_LEAD_CREATED',
          conditions: {},
          actions: Array.from({ length: 6 }, () => ({ type: 'notify', to: 'admins', title: 'Hi' })),
        }),
      ).toBeTruthy();
      expect(
        await bad({
          name: 'x',
          trigger: 'WEB_LEAD_CREATED',
          conditions: {},
          actions: [{ type: 'notify', to: 'counselor', title: 'Hi' }],
        }),
      ).toHaveProperty(['actions.0.to']);
      expect(
        await bad({
          name: 'x',
          trigger: 'WEB_LEAD_CREATED',
          conditions: {},
          actions: [{ type: 'assign_round_robin', role: 'TELECALLER' }],
        }),
      ).toHaveProperty(['actions.0.role']);
      expect(
        await bad({ name: '  ', trigger: 'WEB_LEAD_CREATED', conditions: {}, actions: [] }),
      ).toBeTruthy();
    });

    it('creates, edits, turns off and deletes a rule (audited), and a changed trigger starts clean', async () => {
      const rule = await automation.createRule(adminCtx, {
        name: 'Tell me about Interested leads',
        trigger: 'STAGE_CHANGED',
        conditions: { toStage: 'INTERESTED' },
        actions: [{ type: 'notify', to: 'admins', title: '{name} is {stage}' }],
      });
      expect(rule).toMatchObject({ isActive: true, when: 'changes to Interested' });
      expect(rule.does).toEqual(['Notify the admins: “{name} is {stage}”']);

      const off = await automation.updateRule(adminCtx, rule.id, { isActive: false });
      expect(off.isActive).toBe(false);
      // Another trigger: the old conditions belong to the old trigger, so they are not carried over.
      const switched = await automation.updateRule(adminCtx, rule.id, { trigger: 'FOLLOWUP_OVERDUE' });
      expect(switched.conditions).toEqual({});
      // …and the old actions are still checked against the new trigger.
      expect(
        await code(
          automation.updateRule(adminCtx, rule.id, {
            trigger: 'WEB_LEAD_CREATED',
            actions: [{ type: 'escalate' }],
          }),
        ),
      ).toBe('VALIDATION_ERROR');
      const moved = await automation.updateRule(adminCtx, rule.id, {
        conditions: { minutesOverdue: 60 },
        actions: [{ type: 'escalate' }],
      });
      expect(moved).toMatchObject({ trigger: 'FOLLOWUP_OVERDUE', when: 'overdue by 1 hour' });

      expect(await code(automation.deleteRule(adminCtx, rule.id))).toBe('OK');
      expect(await code(automation.deleteRule(adminCtx, rule.id))).toBe('NOT_FOUND');
      const audited = await ownerDb().auditLog.findMany({
        where: { tenantId: tenant.id, action: { startsWith: 'automation.' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(audited.map((a) => a.action)).toEqual([
        'automation.created',
        'automation.updated', // switched off
        'automation.updated', // trigger changed
        'automation.updated', // conditions and actions edited
        'automation.deleted',
      ]);
    });

    it('limits how many rules a workspace has', async () => {
      const make = (n: number) =>
        automation.createRule(adminCtx, {
          name: `Rule ${n}`,
          trigger: 'FOLLOWUP_OVERDUE',
          conditions: {},
          actions: [{ type: 'escalate' }],
        });
      for (let n = 0; n < MAX_RULES; n++) await make(n);
      expect(await code(make(MAX_RULES))).toBe('CONFLICT');
    });

    it('is for admins only, and only within their own workspace', async () => {
      const rule = await automation.createRule(adminCtx, {
        name: 'Mine',
        trigger: 'FOLLOWUP_OVERDUE',
        conditions: {},
        actions: [{ type: 'escalate' }],
      });
      for (const user of [c1, t1]) {
        const ctx = ctxFor(user);
        expect(await code(automation.listRules(ctx))).toBe('FORBIDDEN');
        expect(await code(automation.listRuns(ctx, { limit: 10 }))).toBe('FORBIDDEN');
        expect(await code(automation.updateRule(ctx, rule.id, { isActive: false }))).toBe('FORBIDDEN');
        expect(await code(automation.deleteRule(ctx, rule.id))).toBe('FORBIDDEN');
        expect(await code(automation.installStarterRules(ctx))).toBe('FORBIDDEN');
      }
      const other = await makeTenant('auto-other');
      const otherAdmin = ctxFor(await makeUser(other.id, 'TENANT_ADMIN'));
      expect(await automation.listRules(otherAdmin)).toEqual([]);
      expect(await code(automation.updateRule(otherAdmin, rule.id, { isActive: false }))).toBe('NOT_FOUND');
      expect(await code(automation.deleteRule(otherAdmin, rule.id))).toBe('NOT_FOUND');
    });

    it('installs the five starter rules once, all on, and every new workspace starts with them', async () => {
      expect(await automation.installStarterRules(adminCtx)).toEqual({ added: 5, total: 5 });
      expect(await automation.installStarterRules(adminCtx)).toEqual({ added: 0, total: 5 });
      const rules = await automation.listRules(adminCtx);
      expect(rules).toHaveLength(5);
      expect(rules.every((r) => r.isActive && r.valid)).toBe(true);
      expect(rules.map((r) => r.trigger).sort()).toEqual([
        'FOLLOWUP_OVERDUE',
        'LEAD_UNCONTACTED',
        'STAGE_CHANGED',
        'STAGE_CHANGED',
        'WEB_LEAD_CREATED',
      ]);

      // A workspace made by the platform admin gets them too.
      const { platform } = await import('@avn-cms/core');
      const { validateSession } = await import('@avn-cms/auth');
      const { createSession } = await import('@avn-cms/auth');
      const root = await makeUser(null, 'SUPER_ADMIN');
      const session = await createSession({ userId: root.id, mfaVerified: true });
      const principal = (await validateSession(session.token))!;
      const created = await platform.createTenant(principal, {
        name: 'Fresh Agency',
        slug: 'fresh-agency',
        planCode: 'STARTER',
        adminName: 'Owner',
        adminEmail: 'owner@fresh.test',
      });
      expect(await ownerDb().automationRule.count({ where: { tenantId: created.id, isActive: true } })).toBe(
        5,
      );
    });
  });

  // ── The starter rules, one by one ──────────────────────────────────────────

  describe('new web lead → route to a counselor', () => {
    beforeEach(async () => {
      await automation.installStarterRules(adminCtx);
    });

    it('routes it in turn, tells the counselor, and only they see it', async () => {
      const first = await ingest({ name: 'First Enquiry' });
      const second = await ingest({ name: 'Second Enquiry' });
      const rows = await ownerDb().webLead.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'asc' },
      });
      // Round robin: least recently picked first, so the two counselors alternate.
      expect(rows.map((r) => r.routedToId)).toEqual([c1.id, c2.id]);
      expect(rows.every((r) => r.routedAt)).toBe(true);

      const all = await runs();
      expect(all.map((r) => r.status)).toEqual(['DONE', 'DONE']);
      expect(all[0]?.result).toMatchObject({ summary: expect.stringContaining('Routed to') });

      const told = await notesFor(c1.id);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({
        type: 'automation.notify',
        title: 'New web lead: First Enquiry',
        entityType: 'web_lead',
        entityId: first.id,
        readAt: null,
      });

      // Counselors see only what was routed to them.
      const mine = await webLeads.listInbox(ctxFor(c1), { limit: 50 });
      expect(mine.items.map((i) => i.id)).toEqual([first.id]);
      expect(mine.items[0]?.routedToName).toBeTruthy();
      expect(mine.counts).toEqual({ NEW: 1 });
      expect((await webLeads.listInbox(ctxFor(c2), { limit: 50 })).items.map((i) => i.id)).toEqual([
        second.id,
      ]);
      expect(await code(webLeads.getWebLead(ctxFor(c1), second.id))).toBe('NOT_FOUND');
      expect(await code(webLeads.getWebLead(ctxFor(c1), first.id))).toBe('OK');
      // An admin sees everything, with who it went to.
      const everything = await webLeads.listInbox(adminCtx, { limit: 50 });
      expect(everything.items).toHaveLength(2);
      expect(everything.items.map((i) => i.routedToName).sort()).toEqual([c1, c2].map((c) => c.name).sort());
    });

    it('lets only the routed counselor take it, and an admin convert gives it to them', async () => {
      const first = await ingest({ name: 'Routed Student' });
      expect(await code(webLeads.convert(ctxFor(c2), first.id, {}))).toBe('NOT_FOUND');
      const converted = await webLeads.convert(adminCtx, first.id, {});
      const owner = await ownerDb().leadAssignment.findFirstOrThrow({
        where: { leadId: converted.leadId, roleFunction: 'COUNSELOR', isActive: true },
      });
      expect(owner.assigneeId).toBe(c1.id);

      const second = await ingest({ name: 'Second Student' });
      const mine = await webLeads.convert(ctxFor(c2), second.id, {});
      expect(mine.createdLead).toBe(true);
    });

    it('leaves repeat submissions alone (the starter rule is for new ones)', async () => {
      const existing = await makeLead(tenant.id, { name: 'Already Here' });
      await ingest({ phoneE164: existing.student.phoneE164, phoneRaw: existing.student.phoneE164 });
      expect(await runs()).toEqual([]);
    });

    it('says why when there is no counselor to route to', async () => {
      await ownerDb().user.updateMany({
        where: { id: { in: [c1.id, c2.id] } },
        data: { status: 'DISABLED' },
      });
      const wl = await ingest();
      const [run] = await runs();
      expect(run?.status).toBe('SKIPPED');
      expect(run?.result).toMatchObject({ summary: expect.stringContaining('no active counselor') });
      expect((await ownerDb().webLead.findUniqueOrThrow({ where: { id: wl.id } })).routedToId).toBeNull();
    });

    it('can be narrowed by country, source and NEET score', async () => {
      await ownerDb().automationRule.deleteMany({ where: { tenantId: tenant.id } });
      await automation.createRule(adminCtx, {
        name: 'Georgia, strong scores',
        trigger: 'WEB_LEAD_CREATED',
        conditions: { statuses: ['NEW'], countries: ['georgia'], minNeetScore: 500 },
        actions: [{ type: 'assign_round_robin', role: 'COUNSELOR' }],
      });
      await ingest({ interestCountry: 'Russia', neetScore: 600 });
      await ingest({ interestCountry: 'Georgia', neetScore: 400 });
      await ingest({ interestCountry: 'Georgia', neetScore: null });
      expect(await runs()).toEqual([]);
      await ingest({ interestCountry: 'Georgia', neetScore: 560 });
      expect((await runs()).map((r) => r.status)).toEqual(['DONE']);
    });
  });

  describe('lead stage changes', () => {
    beforeEach(async () => {
      await automation.installStarterRules(adminCtx);
    });

    it('Interested → schedules a call for the owner, once', async () => {
      const { lead, student } = await makeLead(tenant.id, {
        counselorId: c1.id,
        telecallerId: t1.id,
        name: 'Keen Student',
      });
      await leads.updateLead(adminCtx, lead.id, { stage: 'INTERESTED' });
      const calls = await ownerDb().followUp.findMany({ where: { tenantId: tenant.id, leadId: lead.id } });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.assigneeId).toBe(t1.id); // the telecaller owns calls when there is one
      const due = calls[0]!.scheduledAt.getTime() - Date.now();
      expect(Math.abs(due - 24 * 3_600_000)).toBeLessThan(60_000);
      expect((await ownerDb().lead.findUniqueOrThrow({ where: { id: lead.id } })).nextCallAt).toEqual(
        calls[0]?.scheduledAt,
      );
      const [run] = (await runs()).filter((r) => r.rule.starterKey === 'interested_schedule');
      expect(run).toMatchObject({ status: 'DONE', entityId: lead.id });
      const timeline = await ownerDb().activity.findMany({
        where: { studentId: student.id, summary: { contains: 'automation' } },
      });
      expect(timeline.map((a) => a.summary)).toEqual([
        'Call scheduled by automation “Schedule a call when a lead becomes Interested”',
      ]);

      // Back and Interested again: a call is already waiting, so nothing new is scheduled.
      await leads.updateLead(adminCtx, lead.id, { stage: 'CONTACTED' });
      await leads.updateLead(adminCtx, lead.id, { stage: 'INTERESTED' });
      expect(await ownerDb().followUp.count({ where: { tenantId: tenant.id, leadId: lead.id } })).toBe(1);
      const again = (await runs()).filter((r) => r.rule.starterKey === 'interested_schedule');
      expect(again.map((r) => r.status)).toEqual(['DONE', 'SKIPPED']);
      expect(again[1]?.result).toMatchObject({
        summary: expect.stringContaining('already has a call scheduled'),
      });
    });

    it('Interested with nobody assigned says so and schedules nothing', async () => {
      const { lead } = await makeLead(tenant.id, { name: 'Unowned' });
      await leads.updateLead(adminCtx, lead.id, { stage: 'INTERESTED' });
      expect(await ownerDb().followUp.count({ where: { tenantId: tenant.id } })).toBe(0);
      const [run] = await runs();
      expect(run?.status).toBe('SKIPPED');
      expect(run?.result).toMatchObject({ summary: expect.stringContaining('Nobody is assigned') });
    });

    it('Enrolled → stops the reminders, without counting them as calls made', async () => {
      const { lead } = await makeLead(tenant.id, { counselorId: c1.id, telecallerId: t1.id, name: 'Joined' });
      for (const h of [-5, -30]) {
        await ownerDb().followUp.create({
          data: {
            tenantId: tenant.id,
            leadId: lead.id,
            assigneeId: t1.id,
            scheduledAt: new Date(Date.now() - h * 3_600_000),
          },
        });
      }
      const made = await ownerDb().followUp.create({
        data: {
          tenantId: tenant.id,
          leadId: lead.id,
          assigneeId: t1.id,
          scheduledAt: hours(50),
          completedAt: hours(49),
          disposition: 'COMPLETED',
        },
      });
      await ownerDb().lead.update({ where: { id: lead.id }, data: { nextCallAt: hours(30) } });

      await leads.updateLead(adminCtx, lead.id, { stage: 'ENROLLED' });
      const left = await ownerDb().followUp.findMany({ where: { tenantId: tenant.id, leadId: lead.id } });
      expect(left.map((f) => f.id)).toEqual([made.id]); // the call that really happened stays
      expect((await ownerDb().lead.findUniqueOrThrow({ where: { id: lead.id } })).nextCallAt).toBeNull();
      const [run] = (await runs()).filter((r) => r.rule.starterKey === 'enrolled_stop');
      expect(run).toMatchObject({ status: 'DONE', result: { summary: 'Stopped 2 reminders' } });

      // Nothing left to stop: the run says so.
      const { lead: other } = await makeLead(tenant.id, { counselorId: c1.id, name: 'No reminders' });
      await leads.updateLead(adminCtx, other.id, { stage: 'ENROLLED' });
      const second = (await runs()).filter((r) => r.entityId === other.id);
      expect(second[0]).toMatchObject({ status: 'SKIPPED' });
    });

    it('can wait for a particular change, and tell the people involved', async () => {
      await ownerDb().automationRule.deleteMany({ where: { tenantId: tenant.id } });
      await automation.createRule(adminCtx, {
        name: 'Counselor told of first contact',
        trigger: 'STAGE_CHANGED',
        conditions: { toStage: 'CONTACTED', fromStage: 'NEW' },
        actions: [{ type: 'notify', to: 'counselor', title: '{name} moved to {stage}' }],
      });
      const { lead } = await makeLead(tenant.id, { counselorId: c1.id, name: 'First Call' });
      await leads.updateLead(adminCtx, lead.id, { stage: 'INTERESTED' });
      expect(await runs()).toEqual([]); // not the change it waits for
      await leads.updateLead(adminCtx, lead.id, { stage: 'CONTACTED' });
      expect(await runs()).toEqual([]); // right stage, wrong "from"

      const { lead: fresh } = await makeLead(tenant.id, { counselorId: c1.id, name: 'Fresh One' });
      await leads.updateLead(adminCtx, fresh.id, { stage: 'CONTACTED' });
      expect((await runs()).map((r) => r.status)).toEqual(['DONE']);
      const told = await notesFor(c1.id);
      expect(told.map((n) => n.title)).toEqual(['Fresh One moved to Contacted']);
      expect(told[0]).toMatchObject({ entityType: 'lead', entityId: fresh.id });
    });
  });

  describe('uncontacted leads (worker sweep)', () => {
    beforeEach(async () => {
      await automation.installStarterRules(adminCtx);
    });

    it('tells the admins once, after the workspace’s waiting time', async () => {
      const { lead: stale } = await makeLead(tenant.id, { counselorId: c1.id, name: 'Waiting Long' });
      await ownerDb().lead.update({ where: { id: stale.id }, data: { createdAt: hours(2) } });
      const { lead: recent } = await makeLead(tenant.id, { name: 'Just Arrived' }); // not 30 minutes yet
      const { lead: contacted } = await makeLead(tenant.id, { name: 'Already Called' });
      await ownerDb().lead.update({
        where: { id: contacted.id },
        data: { createdAt: hours(2), lastContactedAt: hours(1) },
      });
      const { lead: ancient } = await makeLead(tenant.id, { name: 'Months Old' });
      await ownerDb().lead.update({ where: { id: ancient.id }, data: { createdAt: hours(24 * 10) } });
      const { lead: advanced } = await makeLead(tenant.id, { name: 'Moved On', stage: 'CONTACTED' });
      await ownerDb().lead.update({ where: { id: advanced.id }, data: { createdAt: hours(2) } });

      const first = await sweepAutomation(tenant.id);
      expect(first.uncontacted).toBe(1);
      const [run] = (await runs()).filter((r) => r.rule.starterKey === 'uncontacted_notify');
      expect(run).toMatchObject({ status: 'DONE', entityId: stale.id });
      const told = await notesFor(admin.id);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({
        title: 'Not contacted yet: Waiting Long',
        body: 'This lead has been waiting 30 minutes without a call.',
        entityId: stale.id,
      });
      expect([recent.id, contacted.id, ancient.id, advanced.id]).not.toContain(run?.entityId);

      // The same lead is not reported again by later sweeps.
      expect((await sweepAutomation(tenant.id)).uncontacted).toBe(0);
      expect(await notesFor(admin.id)).toHaveLength(1);
    });

    it('uses the rule’s own minutes and source when it has them', async () => {
      await ownerDb().automationRule.deleteMany({ where: { tenantId: tenant.id } });
      const source = await ownerDb().leadSource.findFirstOrThrow({
        where: { tenantId: tenant.id, code: 'GOOGLE_ADS' },
      });
      await automation.createRule(adminCtx, {
        name: 'Ads leads, 10 minutes',
        trigger: 'LEAD_UNCONTACTED',
        conditions: { minutes: 10, sourceIds: [source.id] },
        actions: [{ type: 'notify', to: 'admins', title: 'Ad lead waiting: {name}' }],
      });
      const { lead: web } = await makeLead(tenant.id, { name: 'Website Lead' });
      const { lead: ad } = await makeLead(tenant.id, { name: 'Ad Lead' });
      await ownerDb().lead.update({
        where: { id: ad.id },
        data: { sourceId: source.id, createdAt: new Date(Date.now() - 15 * 60_000) },
      });
      await ownerDb().lead.update({
        where: { id: web.id },
        data: { createdAt: new Date(Date.now() - 15 * 60_000) },
      });
      expect((await sweepAutomation(tenant.id)).uncontacted).toBe(1);
      expect((await notesFor(admin.id)).map((n) => n.title)).toEqual(['Ad lead waiting: Ad Lead']);
    });

    it('does nothing for a rule that is switched off', async () => {
      const { lead } = await makeLead(tenant.id);
      await ownerDb().lead.update({ where: { id: lead.id }, data: { createdAt: hours(2) } });
      const rule = await ruleByKey('uncontacted_notify');
      await automation.updateRule(adminCtx, rule.id, { isActive: false });
      expect((await sweepAutomation(tenant.id)).uncontacted).toBe(0);
      expect(await runs()).toEqual([]);
    });
  });

  describe('overdue calls (worker sweep)', () => {
    beforeEach(async () => {
      await automation.installStarterRules(adminCtx);
    });

    it('escalates a call that is a day late, once, telling its owner and the admins', async () => {
      const { lead, student } = await makeLead(tenant.id, { telecallerId: t1.id, name: 'Late Call' });
      const late = await ownerDb().followUp.create({
        data: { tenantId: tenant.id, leadId: lead.id, assigneeId: t1.id, scheduledAt: hours(30) },
      });
      const { lead: soon } = await makeLead(tenant.id, { telecallerId: t1.id, name: 'Slightly Late' });
      await ownerDb().followUp.create({
        data: { tenantId: tenant.id, leadId: soon.id, assigneeId: t1.id, scheduledAt: hours(3) },
      });
      const { lead: made } = await makeLead(tenant.id, { telecallerId: t1.id, name: 'Done In Time' });
      await ownerDb().followUp.create({
        data: {
          tenantId: tenant.id,
          leadId: made.id,
          assigneeId: t1.id,
          scheduledAt: hours(40),
          completedAt: hours(39),
          disposition: 'COMPLETED',
        },
      });
      const { lead: old } = await makeLead(tenant.id, { telecallerId: t1.id, name: 'Long Forgotten' });
      await ownerDb().followUp.create({
        data: { tenantId: tenant.id, leadId: old.id, assigneeId: t1.id, scheduledAt: hours(24 * 12) },
      });

      expect((await sweepAutomation(tenant.id)).overdue).toBe(1);
      const row = await ownerDb().followUp.findUniqueOrThrow({ where: { id: late.id } });
      expect(row.escalatedAt).not.toBeNull();
      expect(row.escalatedTo).toBe(admin.id);
      const told = [...(await notesFor(admin.id)), ...(await notesFor(t1.id))];
      expect(told.map((n) => n.title)).toEqual(['Overdue call: Late Call', 'Overdue call: Late Call']);
      expect(told[0]?.body).toMatch(/overdue/);
      expect(
        await ownerDb().activity.count({
          where: { studentId: student.id, summary: { contains: 'escalated' } },
        }),
      ).toBe(1);

      expect((await sweepAutomation(tenant.id)).overdue).toBe(0);
      expect(await notesFor(admin.id)).toHaveLength(1);
    });

    it('does not escalate a call that was made after it was recorded but before it ran', async () => {
      const { lead } = await makeLead(tenant.id, { telecallerId: t1.id });
      const call = await ownerDb().followUp.create({
        data: { tenantId: tenant.id, leadId: lead.id, assigneeId: t1.id, scheduledAt: hours(30) },
      });
      // Record the run, then the call is made before the job gets to it.
      await ownerDb().automationRun.create({
        data: {
          tenantId: tenant.id,
          ruleId: (await ruleByKey('escalate_overdue')).id,
          event: 'FOLLOWUP_OVERDUE',
          entityId: call.id,
          status: 'PENDING',
          dedupeKey: call.id,
          payload: {
            followUpId: call.id,
            leadId: lead.id,
            studentId: lead.studentId,
            name: 'x',
            sourceId: null,
            assigneeId: t1.id,
            priority: 'NORMAL',
            scheduledAt: call.scheduledAt.toISOString(),
            minutesOverdue: 1800,
          },
        },
      });
      await ownerDb().followUp.update({
        where: { id: call.id },
        data: { completedAt: new Date(), disposition: 'COMPLETED' },
      });
      await sweepAutomation(tenant.id, new Date(Date.now() + 120_000)); // queues the stale pending run
      const [run] = await runs();
      expect(run).toMatchObject({
        status: 'SKIPPED',
        result: { summary: expect.stringContaining('made in the meantime') },
      });
      expect((await ownerDb().followUp.findUniqueOrThrow({ where: { id: call.id } })).escalatedAt).toBeNull();
    });

    it('can be limited to hot calls and a different wait', async () => {
      await ownerDb().automationRule.deleteMany({ where: { tenantId: tenant.id } });
      await automation.createRule(adminCtx, {
        name: 'Hot calls, 2 hours',
        trigger: 'FOLLOWUP_OVERDUE',
        conditions: { minutesOverdue: 120, priority: 'HOT' },
        actions: [{ type: 'notify', to: 'assignee', title: 'Hot call is late: {name}' }],
      });
      const { lead: a } = await makeLead(tenant.id, { telecallerId: t1.id, name: 'Hot One' });
      const { lead: b } = await makeLead(tenant.id, { telecallerId: t1.id, name: 'Normal One' });
      await ownerDb().followUp.create({
        data: {
          tenantId: tenant.id,
          leadId: a.id,
          assigneeId: t1.id,
          scheduledAt: hours(3),
          priority: 'HOT',
        },
      });
      await ownerDb().followUp.create({
        data: { tenantId: tenant.id, leadId: b.id, assigneeId: t1.id, scheduledAt: hours(3) },
      });
      expect((await sweepAutomation(tenant.id)).overdue).toBe(1);
      expect((await notesFor(t1.id)).map((n) => n.title)).toEqual(['Hot call is late: Hot One']);
    });
  });

  // ── Guarantees ─────────────────────────────────────────────────────────────

  describe('guarantees', () => {
    it('a rule that is off never runs, and one that is on again does', async () => {
      const rule = await automation.createRule(adminCtx, {
        name: 'Route',
        trigger: 'WEB_LEAD_CREATED',
        conditions: {},
        actions: [{ type: 'assign_round_robin', role: 'COUNSELOR' }],
      });
      await automation.updateRule(adminCtx, rule.id, { isActive: false });
      await ingest();
      expect(await runs()).toEqual([]);
      await automation.updateRule(adminCtx, rule.id, { isActive: true });
      await ingest();
      expect((await runs()).map((r) => r.status)).toEqual(['DONE']);
    });

    it('a rule turned off after its run was recorded does nothing when the job gets to it', async () => {
      const rule = await automation.createRule(adminCtx, {
        name: 'Notify',
        trigger: 'FOLLOWUP_OVERDUE',
        conditions: {},
        actions: [{ type: 'notify', to: 'admins', title: 'Hello' }],
      });
      const run = await ownerDb().automationRun.create({
        data: {
          tenantId: tenant.id,
          ruleId: rule.id,
          event: 'FOLLOWUP_OVERDUE',
          status: 'PENDING',
          dedupeKey: 'k1',
          payload: { name: 'X', leadId: (await makeLead(tenant.id)).lead.id },
        },
      });
      await automation.updateRule(adminCtx, rule.id, { isActive: false });
      await runAutomation({ tenantId: tenant.id, jobId: run.id });
      const after = await ownerDb().automationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after).toMatchObject({
        status: 'SKIPPED',
        result: { summary: 'The rule was turned off before it ran.' },
      });
      expect(await ownerDb().notification.count({ where: { tenantId: tenant.id } })).toBe(0);
    });

    it('a run happens once even if the job is delivered twice', async () => {
      await automation.installStarterRules(adminCtx);
      await ingest();
      const [run] = await runs();
      await runAutomation({ tenantId: tenant.id, jobId: run!.id });
      await runAutomation({ tenantId: tenant.id, jobId: run!.id });
      expect(await notesFor(c1.id)).toHaveLength(1);
    });

    it('a run is all-or-nothing: a failure undoes its earlier steps, and it is tried again', async () => {
      const rule = await automation.createRule(adminCtx, {
        name: 'Two steps',
        trigger: 'STAGE_CHANGED',
        conditions: { toStage: 'INTERESTED' },
        actions: [
          { type: 'notify', to: 'admins', title: 'Step one' },
          { type: 'schedule_followup', afterMinutes: 60, assignee: 'counselor' },
        ],
      });
      const { lead } = await makeLead(tenant.id, { counselorId: c1.id });
      const failOnce = () =>
        vi.mocked(recomputeNextCall).mockRejectedValueOnce(new Error('simulated outage'));

      failOnce();
      await leads.updateLead(adminCtx, lead.id, { stage: 'INTERESTED' });
      let [run] = await runs();
      expect(run).toMatchObject({ status: 'PENDING', attempts: 1 });
      // Step one's notification and step two's follow-up were rolled back together.
      expect(await ownerDb().notification.count({ where: { tenantId: tenant.id } })).toBe(0);
      expect(await ownerDb().followUp.count({ where: { tenantId: tenant.id } })).toBe(0);

      // The next try works: both steps happen, once.
      await runAutomation({ tenantId: tenant.id, jobId: run!.id });
      [run] = await runs();
      expect(run).toMatchObject({ status: 'DONE', attempts: 2 });
      expect(await ownerDb().notification.count({ where: { tenantId: tenant.id } })).toBe(1);
      expect(await ownerDb().followUp.count({ where: { tenantId: tenant.id } })).toBe(1);
      void rule;
    });

    it('gives up after three attempts and says so, leaving nothing half done', async () => {
      await automation.createRule(adminCtx, {
        name: 'Always fails',
        trigger: 'STAGE_CHANGED',
        conditions: { toStage: 'INTERESTED' },
        actions: [
          { type: 'notify', to: 'admins', title: 'Never seen' },
          { type: 'schedule_followup', afterMinutes: 60, assignee: 'counselor' },
        ],
      });
      const { lead } = await makeLead(tenant.id, { counselorId: c1.id });
      vi.mocked(recomputeNextCall).mockRejectedValue(new Error('simulated outage'));
      try {
        await leads.updateLead(adminCtx, lead.id, { stage: 'INTERESTED' });
        const [first] = await runs();
        await runAutomation({ tenantId: tenant.id, jobId: first!.id });
        await runAutomation({ tenantId: tenant.id, jobId: first!.id });
        const [last] = await runs();
        expect(last).toMatchObject({ status: 'FAILED', attempts: 3 });
        expect(last?.result).toMatchObject({ summary: expect.stringContaining('temporary problem') });
        expect(await ownerDb().notification.count({ where: { tenantId: tenant.id } })).toBe(0);
        // A failed run is final: running it again does nothing.
        await runAutomation({ tenantId: tenant.id, jobId: first!.id });
        expect((await runs())[0]?.attempts).toBe(3);
      } finally {
        vi.mocked(recomputeNextCall).mockReset();
      }
    });

    it('a rule whose actions are damaged fails at once with a clear reason', async () => {
      const rule = await automation.createRule(adminCtx, {
        name: 'Damaged',
        trigger: 'FOLLOWUP_OVERDUE',
        conditions: {},
        actions: [{ type: 'escalate' }],
      });
      await ownerDb().automationRule.update({
        where: { id: rule.id },
        data: { actions: [{ type: 'delete_everything' }] },
      });
      const run = await ownerDb().automationRun.create({
        data: {
          tenantId: tenant.id,
          ruleId: rule.id,
          event: 'FOLLOWUP_OVERDUE',
          status: 'PENDING',
          dedupeKey: 'd1',
          payload: {},
        },
      });
      await runAutomation({ tenantId: tenant.id, jobId: run.id });
      const after = await ownerDb().automationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(after.result).toMatchObject({ summary: expect.stringContaining('not valid') });
      expect((await automation.listRules(adminCtx))[0]?.valid).toBe(false);
    });

    it('a rule in one workspace never fires for another’s events', async () => {
      await automation.installStarterRules(adminCtx);
      const other = await makeTenant('auto-b');
      const otherAdmin = await makeUser(other.id, 'TENANT_ADMIN');
      await makeUser(other.id, 'COUNSELOR');
      // The other workspace has no rules: its web lead is untouched, and ours has no runs.
      await webLeads.ingest({
        tenantId: other.id,
        credentialId: null,
        defaultSourceId: null,
        channel: 'PUBLIC_API',
        dto: submission() as never,
        rawPayload: {},
      });
      expect(await ownerDb().automationRun.count()).toBe(0);
      expect(
        await ownerDb().webLead.count({ where: { tenantId: other.id, routedToId: { not: null } } }),
      ).toBe(0);
      expect(await automation.listRules(ctxFor(otherAdmin))).toEqual([]);
      // And a sweep of one workspace creates runs only in that workspace.
      const { lead } = await makeLead(tenant.id);
      await ownerDb().lead.update({ where: { id: lead.id }, data: { createdAt: hours(2) } });
      await sweepAutomation(other.id);
      expect(await ownerDb().automationRun.count()).toBe(0);
      await sweepAutomation(tenant.id);
      expect(await ownerDb().automationRun.count({ where: { tenantId: tenant.id } })).toBe(1);
      expect(await ownerDb().automationRun.count({ where: { tenantId: other.id } })).toBe(0);
    });

    it('recovers runs that were never queued or were cut off, and clears the old log', async () => {
      await automation.installStarterRules(adminCtx);
      const rule = await ruleByKey('uncontacted_notify');
      const lead = (await makeLead(tenant.id, { name: 'Stranded' })).lead;
      const payload = {
        leadId: lead.id,
        studentId: lead.studentId,
        name: 'Stranded',
        sourceId: null,
        minutes: 30,
      };
      const make = (dedupeKey: string, data: Record<string, unknown>) =>
        ownerDb().automationRun.create({
          data: {
            tenantId: tenant.id,
            ruleId: rule.id,
            event: 'LEAD_UNCONTACTED',
            payload,
            dedupeKey,
            status: 'PENDING',
            ...data,
          } as never,
        });
      const stalePending = await make('a', { createdAt: new Date(Date.now() - 5 * 60_000) });
      const cutOff = await make('b', {
        status: 'RUNNING',
        attempts: 1,
        startedAt: new Date(Date.now() - 30 * 60_000),
      });
      const spent = await make('c', {
        status: 'RUNNING',
        attempts: 3,
        startedAt: new Date(Date.now() - 30 * 60_000),
      });
      const old = await make('d', { status: 'DONE', createdAt: new Date(Date.now() - 100 * 86_400_000) });
      const result = await sweepAutomation(tenant.id);
      expect(result).toMatchObject({ requeued: 2, recovered: 2, purged: 1 });
      const status = async (id: string) =>
        (await ownerDb().automationRun.findUnique({ where: { id } }))?.status;
      expect(await status(stalePending.id)).toBe('DONE');
      expect(await status(cutOff.id)).toBe('DONE');
      expect(await status(spent.id)).toBe('FAILED');
      expect(await status(old.id)).toBeUndefined();
    });
  });

  // ── Run log and notifications ──────────────────────────────────────────────

  describe('run log', () => {
    it('lists runs newest first with what happened, filtered and paged', async () => {
      await automation.installStarterRules(adminCtx);
      await ingest({ name: 'One' });
      await ingest({ name: 'Two' });
      await ingest({ name: 'Three' });
      const page1 = await automation.listRuns(adminCtx, { limit: 2 });
      expect(page1.items.map((r) => r.subject)).toEqual(['Three', 'Two']);
      expect(page1.items[0]).toMatchObject({
        ruleName: 'Route new web leads to a counselor',
        event: 'WEB_LEAD_CREATED',
        status: 'DONE',
        summary: expect.stringContaining('Routed to'),
      });
      expect(page1.items[0]?.webLeadId).toBeTruthy();
      expect(page1.nextCursor).toBeTruthy();
      const page2 = await automation.listRuns(adminCtx, { limit: 2, cursor: page1.nextCursor! });
      expect(page2.items.map((r) => r.subject)).toEqual(['One']);
      expect(page2.nextCursor).toBeNull();

      const rule = await ruleByKey('route_web_leads');
      expect((await automation.listRuns(adminCtx, { limit: 10, ruleId: rule.id })).items).toHaveLength(3);
      expect((await automation.listRuns(adminCtx, { limit: 10, status: 'FAILED' })).items).toEqual([]);
      const rules = await automation.listRules(adminCtx);
      expect(rules.find((r) => r.id === rule.id)?.stats).toMatchObject({ runs: 3, done: 3, failed: 0 });
    });

    it('deleting a rule removes its log', async () => {
      await automation.installStarterRules(adminCtx);
      await ingest();
      const rule = await ruleByKey('route_web_leads');
      await automation.deleteRule(adminCtx, rule.id);
      expect(await runs()).toEqual([]);
    });
  });

  describe('notifications', () => {
    it('are private to the person, countable, and markable as read', async () => {
      await automation.installStarterRules(adminCtx);
      await ingest({ name: 'For C1' });
      await ingest({ name: 'For C2' });
      const c1Ctx = ctxFor(c1);
      const mine = await notifications.listNotifications(c1Ctx, { unreadOnly: false, limit: 30 });
      expect(mine.items.map((n) => n.title)).toEqual(['New web lead: For C1']);
      expect(mine.unread).toBe(1);
      expect(await notifications.unreadCount(ctxFor(c2))).toBe(1);
      expect(await notifications.unreadCount(adminCtx)).toBe(0);

      // Someone else's id does nothing; their own is marked.
      const theirs = (await notifications.listNotifications(ctxFor(c2), { unreadOnly: false, limit: 30 }))
        .items[0]!;
      expect(await notifications.markRead(c1Ctx, { ids: [theirs.id] })).toEqual({ marked: 0, unread: 1 });
      expect(await notifications.unreadCount(ctxFor(c2))).toBe(1);
      expect(await notifications.markRead(c1Ctx, { ids: [mine.items[0]!.id] })).toEqual({
        marked: 1,
        unread: 0,
      });
      expect((await notifications.listNotifications(c1Ctx, { unreadOnly: true, limit: 30 })).items).toEqual(
        [],
      );
      expect(await notifications.markRead(ctxFor(c2), { all: true })).toEqual({ marked: 1, unread: 0 });
    });

    it('page through, newest first', async () => {
      const db = ownerDb();
      for (let i = 0; i < 5; i++) {
        await db.notification.create({
          data: {
            tenantId: tenant.id,
            userId: admin.id,
            type: 't',
            title: `n${i}`,
            createdAt: new Date(Date.now() - i * 1000),
          },
        });
      }
      const first = await notifications.listNotifications(adminCtx, { unreadOnly: false, limit: 2 });
      expect(first.items.map((n) => n.title)).toEqual(['n0', 'n1']);
      const next = await notifications.listNotifications(adminCtx, {
        unreadOnly: false,
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(next.items.map((n) => n.title)).toEqual(['n2', 'n3']);
      expect(first.unread).toBe(5);
    });
  });
});
