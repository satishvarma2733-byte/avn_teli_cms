import { documents, imports, leads, platform, usage, users, webLeads } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeEach, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData, webLeadSubmission } from '../fixtures/factory';
import { call, signIn } from './helpers/http';

/**
 * Plan limits and usage against the real database: what a plan allows is enforced where things are
 * added, measured from real rows, shown to the admin, written monthly for billing, and a downgrade can
 * never leave a workspace over its new limits.
 */
describe('plans and usage', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let counselor: Awaited<ReturnType<typeof makeUser>>;

  const plan = (code: 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE', limits: object) =>
    ownerDb().plan.create({ data: { code, name: code[0] + code.slice(1).toLowerCase(), limits } });
  const putOnPlan = async (code: 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE') => {
    const p = await ownerDb().plan.findUniqueOrThrow({ where: { code } });
    await ownerDb().tenant.update({ where: { id: tenant.id }, data: { planId: p.id } });
  };
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      const err = e as { code?: string; message?: string; details?: { code?: string } };
      return err.details?.code === 'PLAN_LIMIT' ? 'PLAN_LIMIT' : (err.code ?? 'ERROR');
    }
  };
  const student = (n: number) => ({
    name: `Student ${n}`,
    phone: `98000000${String(n).padStart(2, '0')}`,
    sourceId: '',
  });

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('plans-co');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@plans.test');
    counselor = await makeUser(tenant.id, 'COUNSELOR', 'c@plans.test');
    await plan('STARTER', { max_users: 3, max_leads: 3, storage_mb: 1 });
    await plan('PROFESSIONAL', { max_users: 15, max_leads: 50_000, storage_mb: 10_240 });
    await plan('ENTERPRISE', {});
  });

  const sourceId = async () =>
    (await ownerDb().leadSource.findFirstOrThrow({ where: { tenantId: tenant.id } })).id;

  describe('a workspace with no plan, or a plan with no limit', () => {
    it('can grow without a limit', async () => {
      for (let n = 0; n < 6; n++) {
        await leads.createStudent(ctxFor(admin), { ...student(n), sourceId: await sourceId() });
      }
      const view = await usage.getUsage(ctxFor(admin));
      expect(view.plan).toBeNull();
      expect(view.lines.map((l) => l.state)).toEqual(['unlimited', 'unlimited', 'unlimited', 'unlimited']);
      await putOnPlan('ENTERPRISE');
      await leads.createStudent(ctxFor(admin), { ...student(7), sourceId: await sourceId() });
      expect((await usage.getUsage(ctxFor(admin))).plan).toMatchObject({ code: 'ENTERPRISE' });
    });
  });

  describe('users', () => {
    it('stop at the plan’s limit; people who are switched off do not count; bringing one back does', async () => {
      await putOnPlan('STARTER'); // 3 active users
      expect(
        await code(
          users.createUser(ctxFor(admin), { name: 'Third', email: 'third@plans.test', role: 'TELECALLER' }),
        ),
      ).toBe('OK');

      const refused = await users
        .createUser(ctxFor(admin), { name: 'Fourth', email: 'fourth@plans.test', role: 'TELECALLER' })
        .catch((e: Error) => e);
      expect(refused).toMatchObject({
        code: 'CONFLICT',
        details: { code: 'PLAN_LIMIT', metered: 'users', limit: 3, used: 3 },
      });
      expect((refused as Error).message).toContain('Your Starter plan has room for 3 active users');
      expect((refused as Error).message).toContain('platform administrator');

      // Switching someone off frees a place; switching them on again needs one.
      await users.updateUser(ctxFor(admin), counselor.id, { status: 'DISABLED' });
      expect(
        await code(
          users.createUser(ctxFor(admin), { name: 'Fourth', email: 'fourth@plans.test', role: 'TELECALLER' }),
        ),
      ).toBe('OK');
      expect(await code(users.updateUser(ctxFor(admin), counselor.id, { status: 'ACTIVE' }))).toBe(
        'PLAN_LIMIT',
      );
    });
  });

  describe('leads', () => {
    it('stop at the plan’s limit for new students, converted web leads and imports', async () => {
      await putOnPlan('STARTER'); // 3 leads
      const src = await sourceId();
      for (let n = 1; n <= 3; n++)
        expect(await code(leads.createStudent(ctxFor(admin), { ...student(n), sourceId: src }))).toBe('OK');
      expect(await code(leads.createStudent(ctxFor(admin), { ...student(4), sourceId: src }))).toBe(
        'PLAN_LIMIT',
      );
      // Nothing was half-created.
      expect(await ownerDb().student.count({ where: { tenantId: tenant.id } })).toBe(3);

      // A website enquiry is always accepted (no enquiry is lost) …
      const { id } = await webLeads.ingest({
        tenantId: tenant.id,
        credentialId: null,
        defaultSourceId: null,
        channel: 'PUBLIC_API',
        dto: webLeadSubmission() as never,
        rawPayload: {},
      });
      expect((await ownerDb().webLead.findUniqueOrThrow({ where: { id } })).status).toBe('NEW');
      // … but turning it into a lead needs room.
      expect(await code(webLeads.convert(ctxFor(admin), id, {}))).toBe('PLAN_LIMIT');
      await putOnPlan('PROFESSIONAL');
      expect(await code(webLeads.convert(ctxFor(admin), id, {}))).toBe('OK');
    });

    it('refuse an import that would not fit, before it starts', async () => {
      await putOnPlan('STARTER');
      const src = await sourceId();
      await makeLead(tenant.id, { counselorId: counselor.id });
      const job = await ownerDb().importJob.create({
        data: {
          tenantId: tenant.id,
          requestedById: admin.id,
          type: 'students',
          status: 'VALIDATED',
          params: {
            options: { mapping: {}, defaultSourceId: src, duplicateMode: 'skip', roundRobin: false },
          },
          result: { total: 10, valid: 10, newRows: 10 },
        },
      });
      const refused = await imports.startRun(ctxFor(admin), job.id, 'skip').catch((e: Error) => e);
      expect(refused).toMatchObject({
        code: 'CONFLICT',
        details: { code: 'PLAN_LIMIT', metered: 'leads', adding: 10 },
      });
      // The import was not started: still waiting for the person to decide.
      expect((await ownerDb().importJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
        'VALIDATED',
      );

      // One that fits is allowed through (it is queued; the queue's refusal is another matter).
      const small = await ownerDb().importJob.create({
        data: {
          tenantId: tenant.id,
          requestedById: admin.id,
          type: 'students',
          status: 'VALIDATED',
          params: {
            options: { mapping: {}, defaultSourceId: src, duplicateMode: 'skip', roundRobin: false },
          },
          result: { total: 2, valid: 2, newRows: 2 },
        },
      });
      const outcome = await imports.startRun(ctxFor(admin), small.id, 'skip').then(
        () => 'started',
        (e: Error) => e,
      );
      expect(outcome === 'started' || !String((outcome as Error).message).includes('plan')).toBe(true);
    });
  });

  describe('stored documents', () => {
    it('stop at the plan’s storage limit', async () => {
      await putOnPlan('STARTER'); // 1 MB
      const { student: s } = await makeLead(tenant.id, { counselorId: counselor.id });
      const start = (sizeBytes: number) =>
        documents.initUpload(ctxFor(admin), {
          filename: 'passport.pdf',
          mimeType: '',
          sizeBytes,
          studentId: s.id,
          docType: 'PASSPORT',
        });
      expect(await code(start(2 * 1024 * 1024))).toBe('PLAN_LIMIT');
      expect(await ownerDb().document.count({ where: { tenantId: tenant.id } })).toBe(0);
      expect(await code(start(300 * 1024))).toBe('OK');
      const used = await usage.getUsage(ctxFor(admin));
      expect(used.lines.find((l) => l.key === 'storage')).toMatchObject({
        used: 300 * 1024,
        limit: 1024 * 1024,
        state: 'ok',
      });
      // A second file that no longer fits.
      expect(await code(start(800 * 1024))).toBe('PLAN_LIMIT');
    });
  });

  describe('what the admin sees', () => {
    it('lines, percentages and states, measured from real rows', async () => {
      await putOnPlan('STARTER');
      const src = await sourceId();
      await leads.createStudent(ctxFor(admin), { ...student(1), sourceId: src });
      await leads.createStudent(ctxFor(admin), { ...student(2), sourceId: src });
      const view = await usage.getUsage(ctxFor(admin));
      expect(view.plan).toEqual({ code: 'STARTER', name: 'Starter' });
      const by = Object.fromEntries(view.lines.map((l) => [l.key, l]));
      expect(by['users']).toMatchObject({ used: 2, limit: 3, percent: 67, state: 'ok' });
      expect(by['leads']).toMatchObject({ used: 2, limit: 3, percent: 67, state: 'ok' });
      await leads.createStudent(ctxFor(admin), { ...student(3), sourceId: src });
      expect((await usage.getUsage(ctxFor(admin))).lines.find((l) => l.key === 'leads')).toMatchObject({
        used: 3,
        percent: 100,
        state: 'full',
      });
    });

    it('counts a month’s automation runs, and only this month’s', async () => {
      const rule = await ownerDb().automationRule.create({
        data: {
          tenantId: tenant.id,
          name: 'r',
          trigger: 'STAGE_CHANGED',
          conditions: { toStage: 'ENROLLED' },
          actions: [{ type: 'stop_reminders' }],
        },
      });
      const run = (dedupeKey: string, createdAt: Date) =>
        ownerDb().automationRun.create({
          data: {
            tenantId: tenant.id,
            ruleId: rule.id,
            event: 'STAGE_CHANGED',
            status: 'DONE',
            dedupeKey,
            createdAt,
          },
        });
      const now = new Date('2026-10-17T10:00:00Z');
      await run('a', new Date('2026-10-02T00:00:00Z'));
      await run('b', new Date('2026-10-16T00:00:00Z'));
      await run('c', new Date('2026-09-30T23:00:00Z'));
      const view = await usage.getUsage(ctxFor(admin), now);
      expect(view.period).toBe('2026-10');
      expect(view.lines.find((l) => l.key === 'automationRuns')).toMatchObject({ used: 2, limit: null });
    });

    it('is for admins only', async () => {
      await expect(usage.getUsage(ctxFor(counselor))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('the monthly snapshot (for billing)', () => {
    it('writes one row per metric and month, and updates it in place', async () => {
      await putOnPlan('PROFESSIONAL');
      await makeLead(tenant.id, { counselorId: counselor.id });
      const now = new Date('2026-10-17T10:00:00Z');
      const first = await usage.snapshotTenantUsage(tenant.id, now);
      expect(first).toMatchObject({ users: 2, leads: 1, storageBytes: 0 });
      const rows = () =>
        ownerDb().usageCounter.findMany({ where: { tenantId: tenant.id }, orderBy: { metric: 'asc' } });
      expect((await rows()).map((r) => [r.metric, r.period, Number(r.value)])).toEqual([
        ['automation_runs', '2026-10', 0],
        ['leads', '2026-10', 1],
        ['storage_bytes', '2026-10', 0],
        ['users', '2026-10', 2],
      ]);
      await makeLead(tenant.id, { counselorId: counselor.id });
      await usage.snapshotTenantUsage(tenant.id, now);
      expect(await rows()).toHaveLength(4);
      expect(Number((await rows()).find((r) => r.metric === 'leads')!.value)).toBe(2);
      // A new month is a new row; the old month stays as billed.
      await usage.snapshotTenantUsage(tenant.id, new Date('2026-11-01T00:30:00Z'));
      expect(await rows()).toHaveLength(8);
    });
  });

  describe('moving an agency to another plan (platform)', () => {
    it('is refused when the agency is over what the new plan allows, and allowed when it fits', async () => {
      const root = await makeUser(null, 'SUPER_ADMIN', 'root@platform.test');
      const principal = { userId: root.id, role: 'SUPER_ADMIN' } as Parameters<
        typeof platform.setTenantPlan
      >[0];
      await putOnPlan('PROFESSIONAL');
      for (let n = 0; n < 5; n++) await makeLead(tenant.id, { counselorId: counselor.id });

      const refused = await platform.setTenantPlan(principal, tenant.id, 'STARTER').catch((e: Error) => e);
      expect(refused).toMatchObject({ code: 'CONFLICT' });
      expect((refused as Error).message).toContain("can't move to Starter");
      expect((refused as Error).message).toContain('5 leads (the plan allows 3)');
      expect(
        (await ownerDb().tenant.findUniqueOrThrow({ where: { id: tenant.id }, include: { plan: true } })).plan
          ?.code,
      ).toBe('PROFESSIONAL');

      expect(await platform.setTenantPlan(principal, tenant.id, 'ENTERPRISE')).toMatchObject({
        plan: { code: 'ENTERPRISE' },
      });
      expect(
        (await ownerDb().tenant.findUniqueOrThrow({ where: { id: tenant.id }, include: { plan: true } })).plan
          ?.code,
      ).toBe('ENTERPRISE');
      const audit = await ownerDb().auditLog.findFirstOrThrow({ where: { action: 'platform.tenant_plan' } });
      expect(audit.newValue).toEqual({ from: 'PROFESSIONAL', to: 'ENTERPRISE' });
      const listed = (await platform.listTenants(principal)).find((t) => t.id === tenant.id)!;
      expect(listed).toMatchObject({
        plan: { code: 'ENTERPRISE' },
        limits: { users: null, leads: null, storageBytes: null },
      });
    });

    it('is for platform staff only', async () => {
      await expect(
        platform.setTenantPlan(
          { userId: admin.id, role: 'TENANT_ADMIN' } as Parameters<typeof platform.setTenantPlan>[0],
          tenant.id,
          'STARTER',
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('over HTTP', () => {
    it('shows the usage page data to the agency admin only, and the plan change to platform staff only', async () => {
      await putOnPlan('STARTER');
      const adminCaller = await signIn('plans-co', 'admin@plans.test');
      const counselorCaller = await signIn('plans-co', 'c@plans.test');

      const mine = await call('usage', 'GET', { caller: adminCaller });
      expect(mine.status).toBe(200);
      expect(mine.body.data.plan).toMatchObject({ code: 'STARTER' });
      expect(mine.body.data.lines.map((l: { key: string }) => l.key)).toContain('users');
      expect((await call('usage', 'GET', { caller: counselorCaller })).status).toBe(403);

      // An agency admin cannot move their own agency to a bigger plan.
      const move = await call('platform/tenants/[id]/plan', 'PATCH', {
        caller: adminCaller,
        params: { id: tenant.id },
        body: { planCode: 'ENTERPRISE' },
      });
      expect(move.status).toBe(403);
      expect(
        (await ownerDb().tenant.findUniqueOrThrow({ where: { id: tenant.id }, include: { plan: true } })).plan
          ?.code,
      ).toBe('STARTER');
    });
  });
});
