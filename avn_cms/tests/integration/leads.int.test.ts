import { AppError, followups, leads } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeEach, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};

describe('students & leads', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let counselor: Awaited<ReturnType<typeof makeUser>>;
  let counselor2: Awaited<ReturnType<typeof makeUser>>;
  let telecaller: Awaited<ReturnType<typeof makeUser>>;
  let websiteSource: { id: string };

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('acme');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    counselor = await makeUser(tenant.id, 'COUNSELOR');
    counselor2 = await makeUser(tenant.id, 'COUNSELOR');
    telecaller = await makeUser(tenant.id, 'TELECALLER');
    websiteSource = await ownerDb().leadSource.findFirstOrThrow({
      where: { tenantId: tenant.id, code: 'WEBSITE' },
    });
  });

  it('creates a student + lead with history, timeline and audit; blocks a duplicate phone', async () => {
    const res = await leads.createStudent(ctxFor(admin), {
      name: 'Riya Rao',
      phone: '98765 43210',
      sourceId: websiteSource.id,
      counselorId: counselor.id,
      telecallerId: telecaller.id,
      note: 'Called from the website form',
    });
    const db = ownerDb();
    const student = await db.student.findFirstOrThrow({ where: { id: res.studentId } });
    expect(student.phoneE164).toBe('+919876543210');
    expect(await db.leadStatusHistory.count({ where: { leadId: res.leadId } })).toBe(1);
    expect(await db.leadAssignment.count({ where: { leadId: res.leadId, isActive: true } })).toBe(2);
    expect(await db.activity.count({ where: { leadId: res.leadId } })).toBe(2); // created + note
    expect(await db.auditLog.count({ where: { action: 'student.create', entityId: res.studentId } })).toBe(1);

    // Same number written differently → conflict that points at the existing lead.
    const err = await leads
      .createStudent(ctxFor(admin), {
        name: 'Someone else',
        phone: '+91-98765-43210',
        sourceId: websiteSource.id,
      })
      .catch((e: AppError) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('CONFLICT');
    expect((err as AppError).details).toMatchObject({ leadId: res.leadId });
  });

  it('a counselor creating a student is assigned automatically and cannot assign others', async () => {
    const res = await leads.createStudent(ctxFor(counselor), {
      name: 'Arjun',
      phone: '9000011111',
      sourceId: websiteSource.id,
    });
    const a = await ownerDb().leadAssignment.findFirstOrThrow({
      where: { leadId: res.leadId, roleFunction: 'COUNSELOR' },
    });
    expect(a.assigneeId).toBe(counselor.id);
    expect(
      await code(
        leads.createStudent(ctxFor(counselor), {
          name: 'X',
          phone: '9000022222',
          sourceId: websiteSource.id,
          counselorId: counselor2.id,
        }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('telecallers cannot create students', async () => {
    expect(
      await code(
        leads.createStudent(ctxFor(telecaller), {
          name: 'X',
          phone: '9000033333',
          sourceId: websiteSource.id,
        }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('IDOR: another counselor’s lead is 404, and own-scope lists only show own leads', async () => {
    const mine = await makeLead(tenant.id, { counselorId: counselor.id, name: 'Mine' });
    const theirs = await makeLead(tenant.id, { counselorId: counselor2.id, name: 'Theirs' });

    expect(await code(leads.getLead(ctxFor(counselor), mine.lead.id))).toBe('OK');
    expect(await code(leads.getLead(ctxFor(counselor), theirs.lead.id))).toBe('NOT_FOUND');
    expect(await code(leads.updateLead(ctxFor(counselor), theirs.lead.id, { stage: 'CONTACTED' }))).toBe(
      'NOT_FOUND',
    );
    expect(await code(leads.addNote(ctxFor(counselor), theirs.lead.id, 'hi'))).toBe('NOT_FOUND');

    const list = await leads.listLeads(ctxFor(counselor), { view: 'all', sort: 'newest', limit: 50 });
    expect(list.items.map((i) => i.student.name)).toEqual(['Mine']);
    const adminList = await leads.listLeads(ctxFor(admin), { view: 'all', sort: 'newest', limit: 50 });
    expect(adminList.items).toHaveLength(2);
  });

  it('another tenant’s lead is invisible even to its admin', async () => {
    const other = await makeTenant('other');
    const foreign = await makeLead(other.id, { name: 'Foreign' });
    expect(await code(leads.getLead(ctxFor(admin), foreign.lead.id))).toBe('NOT_FOUND');
  });

  it('telecaller: sees reduced fields, can mark HOT, cannot change stage or assignment', async () => {
    const { lead, student } = await makeLead(tenant.id, {
      counselorId: counselor.id,
      telecallerId: telecaller.id,
    });
    await ownerDb().student.update({
      where: { id: student.id },
      data: { email: 'secret@example.test', address: '1 Main St' },
    });
    const detail = await leads.getLead(ctxFor(telecaller), lead.id);
    expect(detail.student.email).toBeNull();
    expect(detail.student.address).toBeNull();
    expect(detail.permissions).toMatchObject({
      changeStage: false,
      markPotential: true,
      assignCounselor: false,
    });

    expect(await code(leads.updateLead(ctxFor(telecaller), lead.id, { priority: 'HOT' }))).toBe('OK');
    expect(await code(leads.updateLead(ctxFor(telecaller), lead.id, { stage: 'CONTACTED' }))).toBe(
      'FORBIDDEN',
    );
    expect(await code(leads.updateLead(ctxFor(telecaller), lead.id, { counselorId: counselor2.id }))).toBe(
      'FORBIDDEN',
    );
    // Phone-only edits.
    expect(await code(leads.updateStudent(ctxFor(telecaller), student.id, { altPhone: '9123456780' }))).toBe(
      'OK',
    );
    expect(await code(leads.updateStudent(ctxFor(telecaller), student.id, { name: 'Renamed' }))).toBe(
      'FORBIDDEN',
    );
  });

  it('stage changes write history + timeline; closing requires a reason', async () => {
    const { lead } = await makeLead(tenant.id, { counselorId: counselor.id });
    await leads.updateLead(ctxFor(counselor), lead.id, { stage: 'INTERESTED', stageNote: 'Wants Georgia' });
    expect(await code(leads.updateLead(ctxFor(counselor), lead.id, { stage: 'LOST' }))).toBe(
      'VALIDATION_ERROR',
    );
    await leads.updateLead(ctxFor(counselor), lead.id, {
      stage: 'LOST',
      lostReason: 'Joined another agency',
    });
    const history = await ownerDb().leadStatusHistory.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => h.toStage)).toEqual(['INTERESTED', 'LOST']);
    const after = await ownerDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.lostReason).toBe('Joined another agency');
    expect(after.lastContactedAt).not.toBeNull();
  });

  it('mass assignment: tenantId in the body cannot move a record', async () => {
    const { lead } = await makeLead(tenant.id, { counselorId: counselor.id });
    const other = await makeTenant('other2');
    // The DTO has no tenantId; a crafted object is stripped by the schema before the service.
    const { leadUpdateSchema } = await import('@avn-cms/core/schemas');
    const parsed = leadUpdateSchema.parse({ priority: 'HOT', tenantId: other.id, stage: 'CONTACTED' });
    expect(parsed).not.toHaveProperty('tenantId');
    await leads.updateLead(ctxFor(admin), lead.id, parsed);
    expect((await ownerDb().lead.findUniqueOrThrow({ where: { id: lead.id } })).tenantId).toBe(tenant.id);
  });

  it('bulk reassign and set stage (admin only)', async () => {
    const a = await makeLead(tenant.id, { counselorId: counselor.id });
    const b = await makeLead(tenant.id, { counselorId: counselor.id });
    expect(
      await code(
        leads.bulkAction(ctxFor(counselor), { action: 'setStage', ids: [a.lead.id], stage: 'CONTACTED' }),
      ),
    ).toBe('FORBIDDEN');
    const r = await leads.bulkAction(ctxFor(admin), {
      action: 'reassign',
      ids: [a.lead.id, b.lead.id],
      counselorId: counselor2.id,
    });
    expect(r.changed).toBe(2);
    const active = await ownerDb().leadAssignment.findMany({
      where: { leadId: { in: [a.lead.id, b.lead.id] }, isActive: true },
    });
    expect(active.every((x) => x.assigneeId === counselor2.id)).toBe(true);
    // History rows are kept.
    expect(await ownerDb().leadAssignment.count({ where: { leadId: a.lead.id, isActive: false } })).toBe(1);
  });

  it('keyset pagination walks every row once', async () => {
    for (let i = 0; i < 7; i++) await makeLead(tenant.id, { name: `S${i}` });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await leads.listLeads(ctxFor(admin), {
        view: 'all',
        sort: 'newest',
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});

describe('follow-ups', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let counselor: Awaited<ReturnType<typeof makeUser>>;
  let telecaller: Awaited<ReturnType<typeof makeUser>>;
  let telecaller2: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('acme');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    counselor = await makeUser(tenant.id, 'COUNSELOR');
    telecaller = await makeUser(tenant.id, 'TELECALLER');
    telecaller2 = await makeUser(tenant.id, 'TELECALLER');
  });

  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  it('schedule → queue → log disposition (timeline + suggested stage) → next call', async () => {
    const { lead } = await makeLead(tenant.id, { counselorId: counselor.id, telecallerId: telecaller.id });
    const { id } = await followups.schedule(ctxFor(counselor), { leadId: lead.id, scheduledAt: inHours(48) });
    const fu = await ownerDb().followUp.findUniqueOrThrow({ where: { id } });
    expect(fu.assigneeId).toBe(telecaller.id); // defaults to the lead's telecaller
    expect((await ownerDb().lead.findUniqueOrThrow({ where: { id: lead.id } })).nextCallAt).toEqual(
      fu.scheduledAt,
    );

    const upcoming = await followups.listQueue(ctxFor(telecaller), { bucket: 'upcoming', limit: 50 });
    expect(upcoming.items.map((i) => i.id)).toEqual([id]);
    const other = await followups.listQueue(ctxFor(telecaller2), { bucket: 'pending', limit: 50 });
    expect(other.items).toHaveLength(0); // own-only queue

    // Telecaller logs the call; the suggested stage is ignored because telecallers can't change stage.
    const r = await followups.update(ctxFor(telecaller), id, {
      disposition: 'INTERESTED',
      outcomeNote: 'Parent asked for fees',
      applyStage: 'INTERESTED',
      nextCallAt: inHours(72),
    });
    expect(r.stageApplied).toBe(false);
    expect(r.nextFollowUpId).not.toBeNull();
    const call = await ownerDb().activity.findFirstOrThrow({ where: { leadId: lead.id, type: 'CALL' } });
    expect(call.summary).toContain('Parent asked for fees');
    const after = await ownerDb().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stage).toBe('NEW');
    expect(after.lastContactedAt).not.toBeNull();

    // Logging the same call twice is refused.
    await expect(followups.update(ctxFor(telecaller), id, { disposition: 'BUSY' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // Counselor logs the next one and applies the stage.
    const r2 = await followups.update(ctxFor(counselor), r.nextFollowUpId!, {
      disposition: 'INTERESTED',
      applyStage: 'INTERESTED',
    });
    expect(r2.stageApplied).toBe(true);
    expect((await ownerDb().lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe('INTERESTED');
    expect((await ownerDb().lead.findUniqueOrThrow({ where: { id: lead.id } })).nextCallAt).toBeNull();
  });

  it('callers cannot book calls for people outside the lead’s team', async () => {
    const { lead } = await makeLead(tenant.id, { counselorId: counselor.id, telecallerId: telecaller.id });
    await expect(
      followups.schedule(ctxFor(counselor), {
        leadId: lead.id,
        scheduledAt: inHours(5),
        assigneeId: telecaller2.id,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      followups.schedule(ctxFor(admin), {
        leadId: lead.id,
        scheduledAt: inHours(5),
        assigneeId: telecaller2.id,
      }),
    ).resolves.toBeTruthy();
  });

  it('overdue sweep flags calls once; escalating them is an automation rule (tests/integration/automation)', async () => {
    const { lead } = await makeLead(tenant.id, { telecallerId: telecaller.id });
    await ownerDb().followUp.create({
      data: {
        tenantId: tenant.id,
        leadId: lead.id,
        assigneeId: telecaller.id,
        scheduledAt: new Date(Date.now() - 30 * 3_600_000),
      },
    });
    const { withTenant } = await import('@avn-cms/db');
    const first = await withTenant(tenant.id, (db) => followups.sweepOverdue(db));
    expect(first).toEqual({ flagged: 1 });
    const second = await withTenant(tenant.id, (db) => followups.sweepOverdue(db));
    expect(second).toEqual({ flagged: 0 });
    // The sweep only marks the call; telling people is the escalation rule's job.
    expect(await ownerDb().notification.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});
