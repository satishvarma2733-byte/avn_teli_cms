import { contextFor, login, validateSession } from '@avn-cms/auth';
import { AppError, leads, platform, users } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeEach, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { TEST_PASSWORD, makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};

describe('users workspace', () => {
  let tenant: { id: string; slug: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('team');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@team.test');
  });

  it('admin adds a user (invite link when email is off); counselors cannot', async () => {
    const created = await users.createUser(ctxFor(admin), {
      name: 'New Counselor',
      email: 'new@team.test',
      role: 'COUNSELOR',
    });
    expect(created.invite.emailed).toBe(false); // SMTP is not configured in tests
    expect(created.invite).toHaveProperty('link');
    expect(await ownerDb().passwordResetToken.count({ where: { userId: created.id, usedAt: null } })).toBe(1);
    expect(
      await code(users.createUser(ctxFor(admin), { name: 'Dup', email: 'NEW@team.test', role: 'COUNSELOR' })),
    ).toBe('CONFLICT');

    const c = await makeUser(tenant.id, 'COUNSELOR');
    expect(await code(users.listUsers(ctxFor(c)))).toBe('FORBIDDEN');
    expect(
      await code(users.createUser(ctxFor(c), { name: 'X', email: 'x@team.test', role: 'TENANT_ADMIN' })),
    ).toBe('FORBIDDEN');
  });

  it('role change is audited and signs the user out; self-demotion and last-admin removal are refused', async () => {
    const c = await makeUser(tenant.id, 'COUNSELOR', 'c@team.test');
    const s = await login({ workspace: 'team', email: 'c@team.test', password: TEST_PASSWORD });
    if (!s.ok) throw new Error('login failed');
    await users.updateUser(ctxFor(admin), c.id, { role: 'TELECALLER' });
    expect(await validateSession(s.token)).toBeNull();
    expect(await ownerDb().auditLog.count({ where: { action: 'user.role_change', entityId: c.id } })).toBe(1);

    expect(await code(users.updateUser(ctxFor(admin), admin.id, { role: 'COUNSELOR' }))).toBe('FORBIDDEN');
    const admin2 = await makeUser(tenant.id, 'TENANT_ADMIN');
    // With two admins, one may disable the other…
    expect(await code(users.updateUser(ctxFor(admin2), admin.id, { status: 'DISABLED' }))).toBe('OK');
    // …but the last active admin can't be disabled or demoted.
    expect(await code(users.updateUser(ctxFor(admin), admin2.id, { status: 'DISABLED' }))).toBe('CONFLICT');
    expect(await code(users.updateUser(ctxFor(admin), admin2.id, { role: 'COUNSELOR' }))).toBe('CONFLICT');
  });

  it('delete is refused until leads are transferred; transfer moves assignments and open calls', async () => {
    const c1 = await makeUser(tenant.id, 'COUNSELOR');
    const c2 = await makeUser(tenant.id, 'COUNSELOR');
    const { lead } = await makeLead(tenant.id, { counselorId: c1.id });
    await ownerDb().followUp.create({
      data: {
        tenantId: tenant.id,
        leadId: lead.id,
        assigneeId: c1.id,
        scheduledAt: new Date(Date.now() + 3_600_000),
      },
    });

    expect(await code(users.deleteUser(ctxFor(admin), c1.id))).toBe('CONFLICT');
    const t = await users.transferLeads(ctxFor(admin), c1.id, { toUserId: c2.id });
    expect(t).toEqual({ assignments: 1, openCalls: 1 });
    const active = await ownerDb().leadAssignment.findFirstOrThrow({
      where: { leadId: lead.id, isActive: true },
    });
    expect(active.assigneeId).toBe(c2.id);
    expect(await code(users.deleteUser(ctxFor(admin), c1.id))).toBe('OK');
    expect((await ownerDb().user.findUniqueOrThrow({ where: { id: c1.id } })).deletedAt).not.toBeNull();
  });

  it('a telecaller’s leads can’t be transferred to a counselor-only role mismatch', async () => {
    const t1 = await makeUser(tenant.id, 'TELECALLER');
    const c = await makeUser(tenant.id, 'COUNSELOR');
    await makeLead(tenant.id, { telecallerId: t1.id });
    expect(await code(users.transferLeads(ctxFor(admin), t1.id, { toUserId: c.id }))).toBe(
      'VALIDATION_ERROR',
    );
  });
});

describe('platform & impersonation', () => {
  beforeEach(async () => {
    await resetData();
  });

  it('super admin creates a tenant, impersonates with audit, and only sees data while acting', async () => {
    const sa = await makeUser(null, 'SUPER_ADMIN', 'root@platform.test');
    const s = await login({ workspace: '', email: 'root@platform.test', password: TEST_PASSWORD });
    if (!s.ok) throw new Error('login failed');
    let p = (await validateSession(s.token))!;
    expect(contextFor(p)).toBeNull(); // no tenant data without impersonation

    const created = await platform.createTenant(p, {
      name: 'New Agency',
      slug: 'new-agency',
      planCode: 'STARTER',
      adminName: 'Owner',
      adminEmail: 'owner@new.test',
    });
    expect(await ownerDb().leadSource.count({ where: { tenantId: created.id } })).toBe(8);
    await makeLead(created.id, { name: 'Visible only when acting' });

    await platform.startImpersonation(p, created.id);
    p = (await validateSession(s.token))!;
    const ctx = contextFor(p)!;
    expect(ctx).toMatchObject({ tenantId: created.id, role: 'SUPER_ADMIN', impersonatedBy: sa.id });
    const list = await leads.listLeads(ctx, { view: 'all', sort: 'newest', limit: 10 });
    expect(list.items).toHaveLength(1);
    // Super admins can look, not create students (RBAC: ❌).
    expect(
      await code(
        leads.createStudent(ctx, {
          name: 'x',
          phone: '9876543210',
          sourceId: (await ownerDb().leadSource.findFirstOrThrow({ where: { tenantId: created.id } })).id,
        }),
      ),
    ).toBe('FORBIDDEN');

    expect(
      await ownerDb().auditLog.count({
        where: { tenantId: created.id, action: 'impersonation.start', impersonatedBy: sa.id },
      }),
    ).toBe(1);
    await platform.stopImpersonation(p);
    expect(contextFor((await validateSession(s.token))!)).toBeNull();
    expect(
      await ownerDb().auditLog.count({ where: { tenantId: created.id, action: 'impersonation.stop' } }),
    ).toBe(1);
  });

  it('suspending a tenant ends its sessions and blocks sign-in', async () => {
    const sa = await makeUser(null, 'SUPER_ADMIN', 'root2@platform.test');
    const t = await makeTenant('sus');
    await makeUser(t.id, 'TENANT_ADMIN', 'a@sus.test');
    const s = await login({ workspace: 'sus', email: 'a@sus.test', password: TEST_PASSWORD });
    if (!s.ok) throw new Error('login failed');
    const sp = (await validateSession(
      (
        (await login({ workspace: '', email: 'root2@platform.test', password: TEST_PASSWORD })) as {
          token: string;
        }
      ).token,
    ))!;
    await platform.setTenantStatus(sp, t.id, 'SUSPENDED');
    expect(await validateSession(s.token)).toBeNull();
    expect(await login({ workspace: 'sus', email: 'a@sus.test', password: TEST_PASSWORD })).toMatchObject({
      ok: false,
      reason: 'SUSPENDED',
    });
    void sa;
  });

  it('non-super-admins are refused by every platform function', async () => {
    const t = await makeTenant('plain');
    await makeUser(t.id, 'TENANT_ADMIN', 'a@plain.test');
    const s = await login({ workspace: 'plain', email: 'a@plain.test', password: TEST_PASSWORD });
    if (!s.ok) throw new Error('login failed');
    const p = (await validateSession(s.token))!;
    expect(await code(platform.listTenants(p))).toBe('FORBIDDEN');
    expect(await code(platform.startImpersonation(p, t.id))).toBe('FORBIDDEN');
    expect(await code(platform.setTenantStatus(p, t.id, 'SUSPENDED'))).toBe('FORBIDDEN');
  });
});
