import { intakeCredentials, webLeads } from '@avn-cms/core';
import { ACTIONS, can, type Action } from '@avn-cms/core/policy';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeAll, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData, webLeadSubmission } from '../fixtures/factory';
import { call, signIn, type Caller, type Method } from './helpers/http';

/**
 * Whose data a caller can reach: other workspaces (tenant leak / IDOR), other people's records in the
 * same workspace (BOLA), things their role must not do (RBAC on every route), and hostile input
 * (injection). Every probe goes through the real route handlers with real sessions.
 */

/** Appears in every record of workspace B, so a leak is easy to spot in any answer. */
const MARK = 'ZZ-Tenant-B-Secret';

interface World {
  tenantA: { id: string };
  tenantB: { id: string };
  adminA: Caller;
  counselorA1: Caller;
  counselorA2: Caller;
  telecallerA: Caller;
  /** Workspace B's records, by kind. */
  b: Record<string, string>;
  /** A record of workspace A that belongs to counselor 1. */
  a: Record<string, string>;
}

let world: World;

async function buildWorld(): Promise<World> {
  await resetData();
  const db = ownerDb();
  const tenantA = await makeTenant('tenant-a');
  const tenantB = await makeTenant('tenant-b');

  await makeUser(tenantA.id, 'TENANT_ADMIN', 'admin@a.test');
  const c1 = await makeUser(tenantA.id, 'COUNSELOR', 'c1@a.test');
  const c2 = await makeUser(tenantA.id, 'COUNSELOR', 'c2@a.test');
  await makeUser(tenantA.id, 'TELECALLER', 't@a.test');
  const { lead: leadA1, student: studentA1 } = await makeLead(tenantA.id, {
    counselorId: c1.id,
    name: 'Alpha One',
  });
  const followA1 = await db.followUp.create({
    data: {
      tenantId: tenantA.id,
      leadId: leadA1.id,
      assigneeId: c1.id,
      scheduledAt: new Date(Date.now() + 3_600_000),
      disposition: 'SCHEDULED',
      priority: 'NORMAL',
      createdById: c1.id,
    },
  });

  const sourceA = await db.leadSource.findFirstOrThrow({ where: { tenantId: tenantA.id, code: 'WEBSITE' } });
  const adminB = await makeUser(tenantB.id, 'TENANT_ADMIN', 'admin@b.test');
  const counselorB = await makeUser(tenantB.id, 'COUNSELOR', 'c@b.test');
  const { lead, student } = await makeLead(tenantB.id, { counselorId: counselorB.id, name: MARK });
  const followUp = await db.followUp.create({
    data: {
      tenantId: tenantB.id,
      leadId: lead.id,
      assigneeId: counselorB.id,
      scheduledAt: new Date(Date.now() + 3_600_000),
      disposition: 'SCHEDULED',
      priority: 'NORMAL',
      createdById: counselorB.id,
    },
  });
  const webLead = await webLeads.ingest({
    tenantId: tenantB.id,
    credentialId: null,
    defaultSourceId: null,
    channel: 'PUBLIC_API',
    dto: webLeadSubmission({ name: MARK }) as never,
    rawPayload: {},
  });
  const folder = await db.folder.create({
    data: { tenantId: tenantB.id, name: MARK, createdById: adminB.id },
  });
  const document = await db.document.create({
    data: {
      tenantId: tenantB.id,
      studentId: student.id,
      seriesId: '00000000-0000-4000-8000-0000000000b1',
      docType: 'PASSPORT',
      filename: `${MARK}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      storageKey: `${tenantB.id}/${MARK}`,
      scanStatus: 'CLEAN',
      uploadedAt: new Date(),
    },
  });
  await db.studentDocument.create({
    data: {
      tenantId: tenantB.id,
      studentId: student.id,
      docType: 'PASSPORT',
      documentId: document.id,
      status: 'UPLOADED',
    },
  });
  const source = await db.leadSource.findFirstOrThrow({ where: { tenantId: tenantB.id, code: 'WEBSITE' } });
  const credential = await intakeCredentials.createCredential(ctxFor(adminB), { name: MARK });
  const rule = await db.automationRule.create({
    data: {
      tenantId: tenantB.id,
      name: MARK,
      trigger: 'STAGE_CHANGED',
      conditions: { toStage: 'ENROLLED' },
      actions: [{ type: 'stop_reminders' }],
    },
  });
  const notification = await db.notification.create({
    data: { tenantId: tenantB.id, userId: adminB.id, type: 'x', title: MARK },
  });
  const exportJob = await db.exportJob.create({
    data: {
      tenantId: tenantB.id,
      requestedById: adminB.id,
      type: 'leads',
      status: 'DONE',
      params: { name: MARK },
    },
  });
  const importJob = await db.importJob.create({
    data: {
      tenantId: tenantB.id,
      requestedById: adminB.id,
      type: 'students',
      status: 'DRAFT',
      params: { name: MARK },
    },
  });
  const file = await db.storedFile.create({
    data: {
      tenantId: tenantB.id,
      purpose: 'EXPORT',
      filename: `${MARK}.csv`,
      mimeType: 'text/csv',
      sizeBytes: 1,
      data: Buffer.from(MARK),
      createdById: adminB.id,
    },
  });
  await signIn('tenant-b', 'admin@b.test');
  const sessionB = await db.session.findFirstOrThrow({ where: { userId: adminB.id } });

  return {
    tenantA,
    tenantB,
    adminA: await signIn('tenant-a', 'admin@a.test'),
    counselorA1: await signIn('tenant-a', 'c1@a.test'),
    counselorA2: await signIn('tenant-a', 'c2@a.test'),
    telecallerA: await signIn('tenant-a', 't@a.test'),
    b: {
      student: student.id,
      lead: lead.id,
      followUp: followUp.id,
      webLead: webLead.id,
      user: counselorB.id,
      adminUser: adminB.id,
      folder: folder.id,
      document: document.id,
      source: source.id,
      credential: credential.id,
      rule: rule.id,
      notification: notification.id,
      exportJob: exportJob.id,
      importJob: importJob.id,
      file: file.id,
      session: sessionB.id,
    },
    a: { student: studentA1.id, lead: leadA1.id, followUp: followA1.id, c2: c2.id, source: sourceA.id },
  };
}

/** Everything workspace B owns that a probe could change, as one comparable string. */
async function snapshotB(): Promise<string> {
  const db = ownerDb();
  const t = world.tenantB.id;
  const byTenant = { where: { tenantId: t }, orderBy: { id: 'asc' as const } };
  const parts = await Promise.all([
    db.student.findMany(byTenant),
    db.lead.findMany(byTenant),
    db.leadAssignment.findMany(byTenant),
    db.followUp.findMany(byTenant),
    db.note.findMany(byTenant),
    db.activity.findMany(byTenant),
    db.webLead.findMany(byTenant),
    db.user.findMany({
      ...byTenant,
      select: { id: true, name: true, roleCode: true, status: true, deletedAt: true },
    }),
    db.folder.findMany(byTenant),
    db.document.findMany(byTenant),
    db.studentDocument.findMany(byTenant),
    db.leadSource.findMany(byTenant),
    db.intakeCredential.findMany({
      ...byTenant,
      select: { id: true, name: true, revokedAt: true, secretHash: true },
    }),
    db.automationRule.findMany(byTenant),
    db.notification.findMany(byTenant),
    db.exportJob.findMany(byTenant),
    db.importJob.findMany(byTenant),
    db.storedFile.findMany({ ...byTenant, select: { id: true, filename: true } }),
    db.session.findMany({ where: { user: { tenantId: t } }, orderBy: { id: 'asc' } }),
  ]);
  return JSON.stringify(parts, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

beforeAll(async () => {
  world = await buildWorld();
}, 120_000);

describe('another workspace (tenant leak / IDOR)', () => {
  /** What workspace A's admin tries on workspace B's records. */
  const probes = (
    w: World,
  ): {
    route: string;
    method: Method;
    params?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
  }[] => [
    { route: 'students/[id]', method: 'PATCH', params: { id: w.b.student! }, body: { name: 'Hacked' } },
    { route: 'students/[id]', method: 'DELETE', params: { id: w.b.student! } },
    { route: 'leads/[id]', method: 'GET', params: { id: w.b.lead! } },
    {
      route: 'leads/[id]',
      method: 'PATCH',
      params: { id: w.b.lead! },
      body: { stage: 'LOST', lostReason: 'x' },
    },
    { route: 'leads/[id]/notes', method: 'POST', params: { id: w.b.lead! }, body: { body: 'Hacked note' } },
    { route: 'leads/[id]/timeline', method: 'GET', params: { id: w.b.lead! } },
    {
      route: 'followups/[id]',
      method: 'PATCH',
      params: { id: w.b.followUp! },
      body: { disposition: 'NO_ANSWER' },
    },
    { route: 'web-leads/[id]', method: 'GET', params: { id: w.b.webLead! } },
    { route: 'web-leads/[id]', method: 'PATCH', params: { id: w.b.webLead! }, body: { status: 'SPAM' } },
    { route: 'web-leads/[id]/convert', method: 'POST', params: { id: w.b.webLead! }, body: {} },
    {
      route: 'users/[id]',
      method: 'PATCH',
      params: { id: w.b.user! },
      body: { name: 'Hacked', status: 'DISABLED' },
    },
    { route: 'users/[id]', method: 'DELETE', params: { id: w.b.user! } },
    { route: 'users/[id]/reset-password', method: 'POST', params: { id: w.b.user! } },
    {
      route: 'users/[id]/transfer-leads',
      method: 'POST',
      params: { id: w.b.user! },
      body: { toUserId: w.a.c2 },
    },
    { route: 'exports/[id]', method: 'GET', params: { id: w.b.exportJob! } },
    { route: 'imports/[id]', method: 'GET', params: { id: w.b.importJob! } },
    { route: 'imports/[id]', method: 'DELETE', params: { id: w.b.importJob! } },
    {
      route: 'imports/[id]/validate',
      method: 'POST',
      params: { id: w.b.importJob! },
      body: {
        mapping: { name: 0, phone: 1 },
        defaultSourceId: w.a.source,
        duplicateMode: 'skip',
        roundRobin: false,
      },
    },
    {
      route: 'imports/[id]/run',
      method: 'POST',
      params: { id: w.b.importJob! },
      body: { duplicateMode: 'skip' },
    },
    {
      route: 'files/[id]',
      method: 'GET',
      params: { id: w.b.file! },
      query: { exp: String(Date.now() + 60_000), sig: 'a'.repeat(64) },
    },
    { route: 'automations/[id]', method: 'PATCH', params: { id: w.b.rule! }, body: { isActive: false } },
    { route: 'automations/[id]', method: 'DELETE', params: { id: w.b.rule! } },
    { route: 'settings/intake-credentials/[id]', method: 'DELETE', params: { id: w.b.credential! } },
    { route: 'settings/intake-credentials/[id]/rotate', method: 'POST', params: { id: w.b.credential! } },
    {
      route: 'settings/sources/[id]',
      method: 'PATCH',
      params: { id: w.b.source! },
      body: { label: 'Hacked' },
    },
    { route: 'folders/[id]', method: 'PATCH', params: { id: w.b.folder! }, body: { name: 'Hacked' } },
    { route: 'folders/[id]', method: 'DELETE', params: { id: w.b.folder! } },
    { route: 'documents/[id]', method: 'GET', params: { id: w.b.document! } },
    { route: 'documents/[id]', method: 'DELETE', params: { id: w.b.document! } },
    { route: 'documents/[id]/url', method: 'GET', params: { id: w.b.document! } },
    { route: 'documents/[id]/complete', method: 'POST', params: { id: w.b.document! } },
    { route: 'documents/[id]/rescan', method: 'POST', params: { id: w.b.document! } },
    { route: 'students/[id]/documents', method: 'GET', params: { id: w.b.student! } },
    {
      route: 'students/[id]/documents/[docType]',
      method: 'PATCH',
      params: { id: w.b.student!, docType: 'PASSPORT' },
      body: { status: 'REJECTED', note: 'Blurry' },
    },
    { route: 'auth/sessions/[id]', method: 'DELETE', params: { id: w.b.session! } },
  ];

  it('cannot see, change or delete any record of another workspace', async () => {
    const before = await snapshotB();
    const wrong: string[] = [];
    for (const p of probes(world)) {
      const res = await call(p.route, p.method, {
        caller: world.adminA,
        params: p.params ?? {},
        ...(p.body !== undefined ? { body: p.body } : {}),
        ...(p.query ? { query: p.query } : {}),
      });
      const text = JSON.stringify(res.body);
      if (res.status !== 404) wrong.push(`${p.method} /api/${p.route} → ${res.status} ${text.slice(0, 100)}`);
      if (text.includes(MARK)) wrong.push(`${p.method} /api/${p.route} leaked workspace B's data`);
    }
    expect(wrong).toEqual([]);
    expect(await snapshotB()).toBe(before);
  });

  it('cannot point its own records at another workspace’s people, sources or leads', async () => {
    const before = await snapshotB();
    const reach = [
      // Create a student for B's counselor / with B's source.
      call('students', 'POST', {
        caller: world.adminA,
        body: { name: 'Cross', phone: '9876500001', sourceId: world.b.source, counselorId: world.b.user },
      }),
      // Hand A's lead to B's counselor.
      call('leads/[id]', 'PATCH', {
        caller: world.adminA,
        params: { id: world.a.lead! },
        body: { counselorId: world.b.user },
      }),
      // Book a call on B's lead, or for B's person.
      call('followups', 'POST', {
        caller: world.adminA,
        body: { leadId: world.b.lead, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() },
      }),
      call('followups', 'POST', {
        caller: world.adminA,
        body: {
          leadId: world.a.lead,
          scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
          assigneeId: world.b.user,
        },
      }),
      // Bulk actions over B's leads.
      call('students/bulk', 'POST', { caller: world.adminA, body: { action: 'block', ids: [world.b.lead] } }),
      call('students/bulk', 'POST', {
        caller: world.adminA,
        body: { action: 'setStage', ids: [world.b.lead], stage: 'LOST' },
      }),
      call('students/bulk', 'POST', {
        caller: world.adminA,
        body: { action: 'reassign', ids: [world.a.lead], counselorId: world.b.user },
      }),
      // A document in B's folder, a new user with B's id, a rule restricted to B's source.
      call('documents', 'POST', {
        caller: world.adminA,
        body: { filename: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 100, folderId: world.b.folder },
      }),
      call('automations', 'POST', {
        caller: world.adminA,
        body: {
          name: 'Cross rule',
          trigger: 'LEAD_UNCONTACTED',
          conditions: { sourceIds: [world.b.source] },
          actions: [{ type: 'escalate' }],
        },
      }),
      // Read B's notification as if it were A's.
      call('notifications/read', 'POST', { caller: world.adminA, body: { ids: [world.b.notification] } }),
    ];
    const replies = await Promise.all(reach);
    for (const res of replies) {
      expect(JSON.stringify(res.body)).not.toContain(MARK);
    }
    // Everything that tried to reach into B was refused or did nothing there.
    expect(
      replies
        .slice(0, 9)
        .map((r) => r.status >= 400 || r.body?.data?.updated === 0 || r.body?.data?.changed === 0),
    ).toEqual(Array(9).fill(true));
    expect(replies[9]!.body.data.marked).toBe(0);
    expect(await snapshotB()).toBe(before);
    // …and A's lead was not handed to B's counselor.
    const assignments = await ownerDb().leadAssignment.findMany({
      where: { leadId: world.a.lead!, isActive: true },
    });
    expect(assignments.some((a) => a.assigneeId === world.b.user)).toBe(false);
  });

  it('lists and searches show only its own workspace, whatever the filter says', async () => {
    const lists: [string, Record<string, string>][] = [
      ['students', {}],
      ['students', { q: MARK }],
      ['students', { q: "' OR '1'='1" }],
      ['students', { q: '%' }],
      ['web-leads', { status: 'NEW' }],
      ['web-leads', { q: MARK }],
      ['followups', { bucket: 'upcoming' }],
      ['users', {}],
      ['folders', {}],
      ['documents', {}],
      ['exports', {}],
      ['imports', {}],
      ['automations', {}],
      ['automations/runs', {}],
      ['notifications', {}],
      ['audit', {}],
      ['directory', { kind: 'sources' }],
      ['directory', { kind: 'counselors' }],
      ['settings', {}],
      ['settings/intake-credentials', {}],
    ];
    for (const [route, query] of lists) {
      const res = await call(route, 'GET', { caller: world.adminA, query });
      expect(res.status, `${route} ${JSON.stringify(query)}`).toBeLessThan(500);
      expect(JSON.stringify(res.body), `${route} ${JSON.stringify(query)}`).not.toContain(MARK);
    }
    // Source ids from another workspace are not accepted as filters either.
    const bySource = await call('students', 'GET', {
      caller: world.adminA,
      query: { sourceId: world.b.source! },
    });
    expect(JSON.stringify(bySource.body)).not.toContain(MARK);
  });

  it('cannot ask a report about another workspace’s people', async () => {
    for (const report of ['funnel', 'sources', 'team', 'status', 'followups']) {
      const res = await call('reports/[report]', 'GET', {
        caller: world.adminA,
        params: { report },
        query: { person: world.b.user! },
      });
      expect(JSON.stringify(res.body), report).not.toContain(MARK);
      expect(res.status, report).toBeLessThan(500);
    }
  });
});

describe('other people in the same workspace (BOLA)', () => {
  it('a counselor reaches only their own leads, calls and web leads', async () => {
    // Counselor 2 against counselor 1's lead.
    const before = JSON.stringify(await ownerDb().lead.findUniqueOrThrow({ where: { id: world.a.lead! } }));
    const attempts: [string, Method, Record<string, string>, unknown?][] = [
      ['leads/[id]', 'GET', { id: world.a.lead! }],
      ['leads/[id]', 'PATCH', { id: world.a.lead! }, { stage: 'CONTACTED' }],
      ['leads/[id]/notes', 'POST', { id: world.a.lead! }, { body: 'not mine' }],
      ['leads/[id]/timeline', 'GET', { id: world.a.lead! }],
      ['students/[id]', 'PATCH', { id: world.a.student! }, { name: 'Not mine' }],
      ['followups/[id]', 'PATCH', { id: world.a.followUp! }, { disposition: 'NO_ANSWER' }],
      ['students/[id]/documents', 'GET', { id: world.a.student! }],
    ];
    for (const [route, method, params, body] of attempts) {
      const res = await call(route, method, { caller: world.counselorA2, params, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${route}`).toBe(404);
    }
    expect(JSON.stringify(await ownerDb().lead.findUniqueOrThrow({ where: { id: world.a.lead! } }))).toBe(
      before,
    );
    expect(JSON.stringify((await call('students', 'GET', { caller: world.counselorA2 })).body)).not.toContain(
      'Alpha One',
    );
    // The owner can.
    expect(
      (await call('leads/[id]', 'GET', { caller: world.counselorA1, params: { id: world.a.lead! } })).status,
    ).toBe(200);
  });

  it('notifications and sessions belong to one person', async () => {
    const mine = await ownerDb().notification.create({
      data: { tenantId: world.tenantA.id, userId: world.adminA.userId, type: 'x', title: 'For the admin' },
    });
    const read = await call('notifications/read', 'POST', {
      caller: world.counselorA1,
      body: { ids: [mine.id] },
    });
    expect(read.body.data.marked).toBe(0);
    expect((await ownerDb().notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt).toBeNull();
    expect(
      JSON.stringify((await call('notifications', 'GET', { caller: world.counselorA1 })).body),
    ).not.toContain('For the admin');

    const adminSession = await ownerDb().session.findFirstOrThrow({ where: { userId: world.adminA.userId } });
    const revoke = await call('auth/sessions/[id]', 'DELETE', {
      caller: world.counselorA1,
      params: { id: adminSession.id },
    });
    expect(revoke.status).toBe(404);
    expect(
      (await ownerDb().session.findUniqueOrThrow({ where: { id: adminSession.id } })).revokedAt,
    ).toBeNull();
  });

  it('exports and downloads belong to the person who asked', async () => {
    const mine = await ownerDb().exportJob.create({
      data: { tenantId: world.tenantA.id, requestedById: world.adminA.userId, type: 'leads', status: 'DONE' },
    });
    expect(
      (await call('exports/[id]', 'GET', { caller: world.counselorA1, params: { id: mine.id } })).status,
    ).toBe(404);
    expect(
      (await call('exports/[id]', 'GET', { caller: world.adminA, params: { id: mine.id } })).status,
    ).toBe(200);
    expect(JSON.stringify((await call('exports', 'GET', { caller: world.counselorA1 })).body)).not.toContain(
      mine.id,
    );
  });
});

describe('what each role may do (every route against the policy)', () => {
  /**
   * Each row says which policy action a route enforces. For every role the answer must follow the
   * matrix: a role the matrix refuses gets 403 before anything is looked up; a role it allows is not
   * turned away (it may still get 404 or 422 for the made-up record).
   */
  const rows: {
    route: string;
    method: Method;
    action?: Action;
    adminOnly?: true;
    body?: unknown;
    query?: Record<string, string>;
  }[] = [
    { route: 'audit', method: 'GET', action: 'audit:view' },
    { route: 'users', method: 'GET', action: 'user:list' },
    { route: 'users', method: 'POST', action: 'user:manage', body: {} },
    { route: 'users/[id]', method: 'PATCH', action: 'user:manage', body: { name: 'x' } },
    { route: 'users/[id]', method: 'DELETE', action: 'user:delete' },
    { route: 'users/[id]/reset-password', method: 'POST', action: 'user:resetPassword' },
    { route: 'users/[id]/transfer-leads', method: 'POST', action: 'user:manage', body: {} },
    { route: 'settings', method: 'GET', action: 'settings:manage' },
    { route: 'settings', method: 'PATCH', action: 'settings:manage', body: {} },
    { route: 'settings/sources', method: 'POST', action: 'settings:manage', body: {} },
    { route: 'settings/sources/[id]', method: 'PATCH', action: 'settings:manage', body: { label: 'x' } },
    { route: 'settings/intake-credentials', method: 'GET', action: 'intakeCredential:manage' },
    { route: 'settings/intake-credentials', method: 'POST', action: 'intakeCredential:manage', body: {} },
    { route: 'settings/intake-credentials/[id]', method: 'DELETE', action: 'intakeCredential:manage' },
    { route: 'settings/intake-credentials/[id]/rotate', method: 'POST', action: 'intakeCredential:manage' },
    { route: 'automations', method: 'GET', action: 'automation:manage' },
    { route: 'automations', method: 'POST', action: 'automation:manage', body: {} },
    { route: 'automations/starter', method: 'POST', action: 'automation:manage' },
    { route: 'automations/runs', method: 'GET', action: 'automation:manage' },
    { route: 'automations/[id]', method: 'PATCH', action: 'automation:manage', body: { isActive: false } },
    { route: 'automations/[id]', method: 'DELETE', action: 'automation:manage' },
    { route: 'imports', method: 'GET', action: 'import:run' },
    { route: 'imports', method: 'POST', action: 'import:run' },
    { route: 'imports/[id]', method: 'GET', action: 'import:run' },
    { route: 'imports/[id]', method: 'DELETE', action: 'import:run' },
    { route: 'imports/[id]/validate', method: 'POST', action: 'import:run', body: {} },
    { route: 'imports/[id]/run', method: 'POST', action: 'import:run', body: {} },
    { route: 'students', method: 'POST', action: 'student:create', body: {} },
    { route: 'students/[id]', method: 'DELETE', action: 'student:delete' },
    { route: 'students/bulk', method: 'POST', action: 'student:bulk', body: {} },
    { route: 'web-leads', method: 'GET', action: 'webLead:view' },
    { route: 'web-leads/[id]', method: 'GET', action: 'webLead:view' },
    { route: 'web-leads/[id]', method: 'PATCH', adminOnly: true, body: { status: 'SPAM' } },
    { route: 'web-leads/[id]/convert', method: 'POST', action: 'webLead:convert', body: {} },
    { route: 'folders', method: 'GET', adminOnly: true },
    { route: 'folders', method: 'POST', adminOnly: true, body: {} },
    { route: 'folders/[id]', method: 'PATCH', adminOnly: true, body: { name: 'x' } },
    { route: 'folders/[id]', method: 'DELETE', adminOnly: true },
    { route: 'documents/stuck', method: 'GET', adminOnly: true },
    { route: 'documents/[id]/rescan', method: 'POST', adminOnly: true },
  ];
  const platformRows: { route: string; method: Method; body?: unknown }[] = [
    { route: 'platform/tenants', method: 'GET' },
    { route: 'platform/tenants', method: 'POST', body: {} },
    { route: 'platform/tenants/[id]', method: 'PATCH', body: { status: 'ACTIVE' } },
    { route: 'platform/tenants/[id]/impersonate', method: 'POST' },
  ];

  const roles = [
    ['TENANT_ADMIN', () => world.adminA],
    ['COUNSELOR', () => world.counselorA1],
    ['TELECALLER', () => world.telecallerA],
  ] as const;

  it('follows the policy matrix on every listed route', async () => {
    const wrong: string[] = [];
    for (const row of rows) {
      for (const [role, caller] of roles) {
        const allowed = row.adminOnly
          ? role === 'TENANT_ADMIN'
          : can({ tenantId: world.tenantA.id, userId: caller().userId, role }, row.action!);
        const res = await call(row.route, row.method, {
          caller: caller(),
          ...(row.body !== undefined ? { body: row.body } : {}),
        });
        if (!allowed && res.status !== 403)
          wrong.push(`${role} ${row.method} /api/${row.route} should be refused, got ${res.status}`);
        if (allowed && res.status === 403)
          wrong.push(`${role} ${row.method} /api/${row.route} should be allowed, got 403`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('keeps the platform routes for platform staff only', async () => {
    const wrong: string[] = [];
    for (const row of platformRows) {
      for (const [role, caller] of roles) {
        const res = await call(row.route, row.method, {
          caller: caller(),
          ...(row.body !== undefined ? { body: row.body } : {}),
        });
        if (res.status !== 403) wrong.push(`${role} ${row.method} /api/${row.route} → ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('keeps every action in the matrix on a route or a page (nothing was forgotten)', () => {
    const covered = new Set(rows.flatMap((r) => (r.action ? [r.action] : [])));
    // These are enforced inside services that several routes share, and are exercised by the workspace
    // suites (leads, follow-ups, documents, exports, reports) rather than by one route each.
    const elsewhere: Action[] = [
      'tenant:manage',
      'tenant:impersonate',
      'platform:analytics',
      'billing:manage',
      'billing:view',
      'account:manage',
      'student:list',
      'student:read',
      'student:update',
      'lead:changeStage',
      'lead:markPotential',
      'lead:assignCounselor',
      'lead:assignTelecaller',
      'followup:view',
      'followup:schedule',
      'followup:logDisposition',
      'note:add',
      'activity:view',
      'export:run',
      'report:viewTenant',
      'report:viewOwn',
      'document:manage',
      'studentDoc:verify',
    ];
    const known = new Set<string>([...covered, ...elsewhere]);
    // Every action in the policy matrix is on a route above or named as enforced inside a shared service.
    // A newly added action fails here until someone places it.
    for (const action of ACTIONS) expect(known.has(action), action).toBe(true);
  });
});

describe('hostile input', () => {
  const payloads = [
    "'; DROP TABLE students; --",
    "' OR '1'='1",
    '" OR ""="',
    '1; SELECT pg_sleep(5)--',
    '\\x00',
    '${7*7}',
    '{{7*7}}',
    '<script>alert(1)</script>',
    '../../../etc/passwd',
    '%27%20OR%201%3D1',
    'a'.repeat(5000),
  ];

  it('search and filter text never reaches SQL as code, and never breaks a list', async () => {
    const students = await ownerDb().student.count();
    for (const q of payloads) {
      for (const [route, query] of [
        ['students', { q }],
        ['web-leads', { q }],
        ['followups', { bucket: 'today', q }],
        ['audit', { entityType: q }],
      ] as const) {
        const res = await call(route, 'GET', { caller: world.adminA, query });
        expect(res.status, `${route} ${q.slice(0, 20)}`).toBeLessThan(500);
        expect(JSON.stringify(res.body)).not.toContain(MARK);
      }
    }
    expect(await ownerDb().student.count()).toBe(students);
    // The table is still there and still answers.
    expect((await call('students', 'GET', { caller: world.adminA })).status).toBe(200);
  });

  it('text saved as a name or note comes back as the same text, never as markup the server changed', async () => {
    const hostile = `<img src=x onerror=alert(1)> "quoted" 'single' & =HYPERLINK("http://evil.example")`;
    const made = await call('students', 'POST', {
      caller: world.adminA,
      body: {
        name: hostile,
        phone: '9876500777',
        sourceId: (await ownerDb().leadSource.findFirstOrThrow({ where: { tenantId: world.tenantA.id } })).id,
      },
    });
    expect(made.status).toBe(201);
    const row = await ownerDb().student.findFirstOrThrow({ where: { phoneE164: '+919876500777' } });
    // Stored exactly as typed (escaping is done when it is shown), so exports and searches see the truth.
    expect(row.name).toBe(hostile);
    const found = await call('students', 'GET', { caller: world.adminA, query: { q: '9876500777' } });
    expect(JSON.stringify(found.body)).toContain('onerror=alert(1)');
  });

  it('refuses a body whose fields have the wrong type, or are lists where a value is expected', async () => {
    for (const body of [
      { name: ['a'], phone: '9876500001' },
      { name: { $ne: null }, phone: '9876500001' },
      { name: 'x', phone: 9876500001 },
      { name: 'x', phone: '9876500001', sourceId: ['not', 'a', 'uuid'] },
      '"just a string"',
      null,
      42,
    ]) {
      const res = await call('students', 'POST', { caller: world.adminA, rawBody: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});
