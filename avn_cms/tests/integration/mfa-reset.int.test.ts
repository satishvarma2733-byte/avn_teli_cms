import {
  beginMfaEnrollment,
  confirmMfa,
  getMfaStatus,
  login,
  totpAt,
  validateSession,
  verifyMfaForSession,
} from '@avn-cms/auth';
import { resetConfigForTests } from '@avn-cms/config';
import { AppError, platform, users } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { TEST_PASSWORD, makeTenant, makeUser, resetData } from '../fixtures/factory';
import { call, signIn } from './helpers/http';

/**
 * The way back for someone who lost both their authenticator and their recovery codes: an admin clears
 * it (users.adminResetMfa), or a super admin does for an agency admin (platform.resetAdminMfa). Against
 * the real database: what is cleared, who is signed out, what is written to the audit log, who is told,
 * who may do it, and what stops a stolen session from doing it.
 */

const BODY = {
  reason: 'Lost phone and recovery codes; confirmed by video call',
  currentPassword: TEST_PASSWORD,
};

/** The error a promise rejects with, or null when it resolves. */
async function failure(p: Promise<unknown>): Promise<AppError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
}

/** Signs the person in and turns two-step verification on. Returns the secret, the codes and the session. */
async function enrol(workspace: string, user: { id: string; email: string }) {
  const res = await login({ workspace, email: user.email, password: TEST_PASSWORD });
  if (!res.ok) throw new Error('login failed');
  const principal = (await validateSession(res.token))!;
  const begun = (await beginMfaEnrollment(user.id, TEST_PASSWORD))!;
  const confirmed = (await confirmMfa(user.id, principal.sessionId, totpAt(begun.secret, Date.now())))!;
  return { secret: begun.secret, codes: confirmed.recoveryCodes, token: res.token };
}

/** A sign-in that is still waiting for its code. */
async function pending(workspace: string, email: string) {
  const res = await login({ workspace, email, password: TEST_PASSWORD });
  if (!res.ok || !res.mfaRequired) throw new Error('expected a second factor');
  return res.token;
}

const auditRows = (action: string) => ownerDb().auditLog.findMany({ where: { action } });

describe('an admin resets someone’s two-step verification', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let admin2: Awaited<ReturnType<typeof makeUser>>;
  let counselor: Awaited<ReturnType<typeof makeUser>>;
  let telecaller: Awaited<ReturnType<typeof makeUser>>;
  let otherAdmin: Awaited<ReturnType<typeof makeUser>>;
  let otherCounselor: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('reset-co');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@reset.test');
    admin2 = await makeUser(tenant.id, 'TENANT_ADMIN', 'admin2@reset.test');
    counselor = await makeUser(tenant.id, 'COUNSELOR', 'c@reset.test');
    telecaller = await makeUser(tenant.id, 'TELECALLER', 't@reset.test');
    const other = await makeTenant('other-co');
    otherAdmin = await makeUser(other.id, 'TENANT_ADMIN', 'admin@other.test');
    otherCounselor = await makeUser(other.id, 'COUNSELOR', 'c@other.test');
  });
  afterEach(() => {
    delete process.env['MFA_REQUIRED_ROLES'];
    resetConfigForTests();
  });

  it('clears the factor and every recovery code, signs the person out everywhere, and lets them in with a password again', async () => {
    const { secret, codes, token } = await enrol('reset-co', counselor);
    const waiting = await pending('reset-co', 'c@reset.test');
    const adminSession = await signIn('reset-co', 'admin@reset.test');
    // A person who has been getting codes wrong: the pause and the counter go too.
    await ownerDb().user.update({
      where: { id: counselor.id },
      data: { mfaFailedCount: 4, mfaLockedUntil: new Date(Date.now() + 600_000) },
    });

    const result = await users.adminResetMfa(ctxFor(admin), counselor.id, BODY);
    expect(result).toEqual({
      id: counselor.id,
      name: counselor.name,
      reenrolmentRequired: false,
      sessionsRevoked: 2,
      notified: { inApp: true, email: false }, // SMTP is not configured in tests
    });

    const row = await ownerDb().user.findUniqueOrThrow({ where: { id: counselor.id } });
    expect(row).toMatchObject({
      mfaSecret: null,
      mfaEnabledAt: null,
      mfaLastStep: null,
      mfaFailedCount: 0,
      mfaLockedUntil: null,
    });
    expect(await ownerDb().mfaRecoveryCode.count({ where: { userId: counselor.id } })).toBe(0);
    expect(await getMfaStatus(counselor.id)).toEqual({ enabled: false, recoveryCodesLeft: 0 });

    // Every device, including the sign-in that was waiting for its code. The admin keeps theirs.
    expect(await validateSession(token)).toBeNull();
    expect(await validateSession(waiting)).toBeNull();
    expect(await validateSession(adminSession.token)).not.toBeNull();

    // Back to a plain password sign-in. The old secret and the old recovery codes are dead.
    const again = await login({ workspace: 'reset-co', email: 'c@reset.test', password: TEST_PASSWORD });
    expect(again).toMatchObject({ ok: true, mfaRequired: false });
    const sessionId = (await validateSession((again as { token: string }).token))!.sessionId;
    expect(
      await verifyMfaForSession(counselor.id, sessionId, totpAt(secret, Date.now() + 60_000)),
    ).toMatchObject({ ok: false });
    expect(await verifyMfaForSession(counselor.id, sessionId, codes[0]!)).toMatchObject({ ok: false });
  });

  it('writes who, why and how to the audit log, and tells the person (in the app, and by email when it is set up)', async () => {
    const { secret } = await enrol('reset-co', counselor);
    await users.adminResetMfa(ctxFor(admin), counselor.id, BODY);

    const rows = await auditRows('auth.mfa_reset_by_admin');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenant.id,
      userId: admin.id,
      entityType: 'user',
      entityId: counselor.id,
      impersonatedBy: null,
    });
    expect(rows[0]!.newValue).toMatchObject({
      reason: BODY.reason,
      via: 'workspace',
      role: 'COUNSELOR',
      reenrolmentRequired: false,
      sessionsRevoked: 1,
    });
    // Nothing secret goes in the log.
    const written = JSON.stringify(rows[0]);
    expect(written).not.toContain(TEST_PASSWORD);
    expect(written).not.toContain(secret);

    const notices = await ownerDb().notification.findMany({ where: { userId: counselor.id } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      tenantId: tenant.id,
      type: 'security.mfa_reset',
      title: 'Your two-step verification was reset',
      readAt: null,
    });
    expect(notices[0]!.body).toContain(admin.name);
    expect(notices[0]!.body).toContain('can turn it back on');
  });

  it('is for admins only, and only inside their own workspace', async () => {
    const { token } = await enrol('reset-co', counselor);
    const foreign = await enrol('other-co', otherCounselor);

    for (const who of [counselor, telecaller]) {
      expect((await failure(users.adminResetMfa(ctxFor(who), counselor.id, BODY)))?.code).toBe('FORBIDDEN');
    }
    // Another workspace's admin sees no such person, and nothing of theirs moves.
    expect((await failure(users.adminResetMfa(ctxFor(otherAdmin), counselor.id, BODY)))?.code).toBe(
      'NOT_FOUND',
    );
    expect((await failure(users.adminResetMfa(ctxFor(admin), otherCounselor.id, BODY)))?.code).toBe(
      'NOT_FOUND',
    );
    expect(
      (await failure(users.adminResetMfa(ctxFor(admin), '00000000-0000-4000-8000-000000000000', BODY)))?.code,
    ).toBe('NOT_FOUND');
    expect(await getMfaStatus(counselor.id)).toEqual({ enabled: true, recoveryCodesLeft: 10 });
    expect(await getMfaStatus(otherCounselor.id)).toEqual({ enabled: true, recoveryCodesLeft: 10 });
    expect(await validateSession(token)).not.toBeNull();
    expect(await validateSession(foreign.token)).not.toBeNull();
    expect(await auditRows('auth.mfa_reset_by_admin')).toHaveLength(0);
    expect(await ownerDb().notification.count({ where: { type: 'security.mfa_reset' } })).toBe(0);
  });

  it('refuses to reset yourself, even as the only admin, and says who to ask', async () => {
    await enrol('reset-co', admin);
    const own = await failure(users.adminResetMfa(ctxFor(admin), admin.id, BODY));
    expect(own?.code).toBe('FORBIDDEN');
    expect(own?.message).toContain('Ask another admin');
    expect(own?.message).toContain('contact aVn CMS support');
    expect(await getMfaStatus(admin.id)).toMatchObject({ enabled: true });

    // A workspace with one admin: no peer can do it, so it is refused here and left to a super admin.
    const solo = await makeTenant('solo-co');
    const only = await makeUser(solo.id, 'TENANT_ADMIN', 'only@solo.test');
    await enrol('solo-co', only);
    expect((await failure(users.adminResetMfa(ctxFor(only), only.id, BODY)))?.code).toBe('FORBIDDEN');
    expect(await getMfaStatus(only.id)).toMatchObject({ enabled: true });
    expect(await auditRows('auth.mfa_reset_by_admin')).toHaveLength(0);
  });

  it('wants the acting admin’s password again, and stops guesses after five tries', async () => {
    await enrol('reset-co', counselor);

    const wrong = await failure(
      users.adminResetMfa(ctxFor(admin2), counselor.id, { ...BODY, currentPassword: 'not-the-password' }),
    );
    expect(wrong?.code).toBe('VALIDATION_ERROR');
    expect(wrong?.details).toMatchObject({ fields: { currentPassword: 'Incorrect password.' } });
    expect(await getMfaStatus(counselor.id)).toMatchObject({ enabled: true });
    expect(await auditRows('auth.mfa_reset_by_admin')).toHaveLength(0);

    // Four more wrong tries use up the five, and then even the right password is not looked at.
    for (let i = 0; i < 4; i++) {
      await failure(
        users.adminResetMfa(ctxFor(admin2), counselor.id, { ...BODY, currentPassword: `guess-${i}` }),
      );
    }
    const blocked = await failure(users.adminResetMfa(ctxFor(admin2), counselor.id, BODY));
    expect(blocked?.code).toBe('RATE_LIMITED');
    expect(await getMfaStatus(counselor.id)).toMatchObject({ enabled: true });

    // The limit is per admin: another admin is not held up by it.
    expect((await failure(users.adminResetMfa(ctxFor(admin), counselor.id, BODY)))?.code ?? 'OK').toBe('OK');
    expect(await getMfaStatus(counselor.id)).toMatchObject({ enabled: false });
  });

  it('has nothing to do when two-step verification is off, and a second reset at the same moment loses cleanly', async () => {
    const off = await failure(users.adminResetMfa(ctxFor(admin), counselor.id, BODY));
    expect(off?.code).toBe('CONFLICT');
    expect(await auditRows('auth.mfa_reset_by_admin')).toHaveLength(0);
    expect(await ownerDb().notification.count({ where: { type: 'security.mfa_reset' } })).toBe(0);

    await enrol('reset-co', counselor);
    const outcomes = await Promise.allSettled([
      users.adminResetMfa(ctxFor(admin), counselor.id, BODY),
      users.adminResetMfa(ctxFor(admin2), counselor.id, BODY),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as AppError).code).toBe('CONFLICT');
    // One reset, one record, one notice.
    expect(await auditRows('auth.mfa_reset_by_admin')).toHaveLength(1);
    expect(await ownerDb().notification.count({ where: { type: 'security.mfa_reset' } })).toBe(1);
  });

  it('makes a role that must use two-step verification set it up again, and lets a peer admin do it for an admin', async () => {
    process.env['MFA_REQUIRED_ROLES'] = 'TENANT_ADMIN';
    resetConfigForTests();
    await enrol('reset-co', admin2);
    await enrol('reset-co', counselor);

    const result = await users.adminResetMfa(ctxFor(admin), admin2.id, BODY);
    expect(result).toMatchObject({ reenrolmentRequired: true, sessionsRevoked: 1 });
    expect((await auditRows('auth.mfa_reset_by_admin'))[0]!.newValue).toMatchObject({
      role: 'TENANT_ADMIN',
      reenrolmentRequired: true,
    });
    const notice = await ownerDb().notification.findFirstOrThrow({ where: { userId: admin2.id } });
    expect(notice.body).toContain('set it up again the next time you sign in');

    // The next sign-in is by password alone, but the session can do nothing except set it up.
    const res = await login({ workspace: 'reset-co', email: 'admin2@reset.test', password: TEST_PASSWORD });
    expect(res).toMatchObject({ ok: true, mfaRequired: false });
    const principal = (await validateSession((res as { token: string }).token))!;
    expect(principal).toMatchObject({ mfaEnabled: false, mfaSetupRequired: true });
    const caller = await signIn('reset-co', 'admin2@reset.test');
    const blocked = await call('students', 'GET', { caller });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details).toMatchObject({ mfaSetupRequired: true });

    // …and it can be set up again, after which the code is asked for as before.
    const begun = (await beginMfaEnrollment(admin2.id, TEST_PASSWORD))!;
    expect(await confirmMfa(admin2.id, principal.sessionId, totpAt(begun.secret, Date.now()))).not.toBeNull();
    expect(
      await login({ workspace: 'reset-co', email: 'admin2@reset.test', password: TEST_PASSWORD }),
    ).toMatchObject({ ok: true, mfaRequired: true });

    // A role that is not required just goes back to having it off.
    const plain = await users.adminResetMfa(ctxFor(admin), counselor.id, BODY);
    expect(plain.reenrolmentRequired).toBe(false);
    const after = await login({ workspace: 'reset-co', email: 'c@reset.test', password: TEST_PASSWORD });
    expect((await validateSession((after as { token: string }).token))!.mfaSetupRequired).toBe(false);
  });

  it('is available to a super admin acting inside the workspace, and says so in the log', async () => {
    await enrol('reset-co', counselor);
    const root = await makeUser(null, 'SUPER_ADMIN', 'root@platform.test');

    await users.adminResetMfa(ctxFor(root, tenant.id), counselor.id, BODY);
    const [row] = await auditRows('auth.mfa_reset_by_admin');
    expect(row).toMatchObject({ userId: root.id, impersonatedBy: root.id, tenantId: tenant.id });
    // The person is not told the name of someone outside the workspace.
    const notice = await ownerDb().notification.findFirstOrThrow({ where: { userId: counselor.id } });
    expect(notice.body).toContain('aVn CMS support');
  });

  describe('over HTTP', () => {
    it('lets an admin do it, leaves the notice for the person, and keeps everyone else out', async () => {
      await enrol('reset-co', counselor);
      await makeUser(tenant.id, 'COUNSELOR', 'c2@reset.test');
      const adminCaller = await signIn('reset-co', 'admin@reset.test');
      const otherCounselorCaller = await signIn('reset-co', 'c2@reset.test');
      const telecallerCaller = await signIn('reset-co', 't@reset.test');

      // Turned away at the gate, before the body is read.
      for (const caller of [otherCounselorCaller, telecallerCaller]) {
        const res = await call('users/[id]/reset-mfa', 'POST', {
          caller,
          params: { id: counselor.id },
          body: BODY,
        });
        expect(res.status).toBe(403);
      }
      const foreign = await signIn('other-co', 'admin@other.test');
      expect(
        (
          await call('users/[id]/reset-mfa', 'POST', {
            caller: foreign,
            params: { id: counselor.id },
            body: BODY,
          })
        ).status,
      ).toBe(404);

      // The reason and the password are both needed.
      const missing = await call('users/[id]/reset-mfa', 'POST', {
        caller: adminCaller,
        params: { id: counselor.id },
        body: { reason: 'ok' },
      });
      expect(missing.status).toBe(422);
      expect(missing.body.error.details.fields).toMatchObject({
        reason: expect.any(String),
        currentPassword: expect.any(String),
      });
      const bad = await call('users/[id]/reset-mfa', 'POST', {
        caller: adminCaller,
        params: { id: counselor.id },
        body: { ...BODY, currentPassword: 'wrong' },
      });
      expect(bad.status).toBe(422);
      expect(await getMfaStatus(counselor.id)).toMatchObject({ enabled: true });

      const done = await call('users/[id]/reset-mfa', 'POST', {
        caller: adminCaller,
        params: { id: counselor.id },
        body: BODY,
      });
      expect(done.status).toBe(200);
      expect(done.body.data).toMatchObject({ id: counselor.id, reenrolmentRequired: false });
      expect(await getMfaStatus(counselor.id)).toMatchObject({ enabled: false });

      // The person signs in with a password and finds the notice waiting.
      const back = await signIn('reset-co', 'c@reset.test');
      const list = await call('notifications', 'GET', { caller: back });
      expect(JSON.stringify(list.body)).toContain('Your two-step verification was reset');

      // The Users list shows it is off now.
      const listed = await call('users', 'GET', { caller: adminCaller });
      const row = (listed.body.data as { id: string; mfaEnabled: boolean }[]).find(
        (u) => u.id === counselor.id,
      );
      expect(row?.mfaEnabled).toBe(false);
    });

    it('lets a super admin do it for an agency admin from the platform console, and no one else', async () => {
      const solo = await makeTenant('solo-co');
      const only = await makeUser(solo.id, 'TENANT_ADMIN', 'only@solo.test');
      const { token } = await enrol('solo-co', only);
      await makeUser(null, 'SUPER_ADMIN', 'root@platform.test');
      const root = await signIn('', 'root@platform.test');
      const path = { id: solo.id, userId: only.id };

      const admins = await call('platform/tenants/[id]/admins', 'GET', {
        caller: root,
        params: { id: solo.id },
      });
      expect(admins.status).toBe(200);
      expect(admins.body.data).toEqual([
        expect.objectContaining({ id: only.id, email: 'only@solo.test', mfaEnabled: true }),
      ]);
      // No password hash or secret in what the console is shown.
      expect(JSON.stringify(admins.body)).not.toMatch(/passwordHash|mfaSecret/);

      // A workspace admin, even of that very workspace, is turned away.
      await makeUser(solo.id, 'TENANT_ADMIN', 'peer@solo.test');
      const peer = await signIn('solo-co', 'peer@solo.test');
      for (const caller of [peer, await signIn('reset-co', 'admin@reset.test')]) {
        expect(
          (
            await call('platform/tenants/[id]/admins/[userId]/reset-mfa', 'POST', {
              caller,
              params: path,
              body: BODY,
            })
          ).status,
        ).toBe(403);
        expect(
          (await call('platform/tenants/[id]/admins', 'GET', { caller, params: { id: solo.id } })).status,
        ).toBe(403);
      }

      const bad = await call('platform/tenants/[id]/admins/[userId]/reset-mfa', 'POST', {
        caller: root,
        params: path,
        body: { ...BODY, currentPassword: 'wrong' },
      });
      expect(bad.status).toBe(422);
      expect(await getMfaStatus(only.id)).toMatchObject({ enabled: true });

      const done = await call('platform/tenants/[id]/admins/[userId]/reset-mfa', 'POST', {
        caller: root,
        params: path,
        body: BODY,
      });
      expect(done.status).toBe(200);
      expect(done.body.data).toMatchObject({ id: only.id, sessionsRevoked: 1 });
      expect(await getMfaStatus(only.id)).toMatchObject({ enabled: false });
      expect(await validateSession(token)).toBeNull();
    });
  });
});

describe('a super admin resets an agency admin', () => {
  let tenant: { id: string };
  let only: Awaited<ReturnType<typeof makeUser>>;
  let root: Awaited<ReturnType<typeof makeUser>>;
  let principal: NonNullable<Awaited<ReturnType<typeof validateSession>>>;

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('solo-co');
    only = await makeUser(tenant.id, 'TENANT_ADMIN', 'only@solo.test');
    root = await makeUser(null, 'SUPER_ADMIN', 'root@platform.test');
    const res = await login({ workspace: '', email: 'root@platform.test', password: TEST_PASSWORD });
    if (!res.ok) throw new Error('login failed');
    principal = (await validateSession(res.token))!;
  });
  afterEach(() => {
    delete process.env['MFA_REQUIRED_ROLES'];
    resetConfigForTests();
  });

  it('clears the factor, signs the admin out, and writes both the platform log and the agency’s', async () => {
    process.env['MFA_REQUIRED_ROLES'] = 'SUPER_ADMIN,TENANT_ADMIN';
    resetConfigForTests();
    const { token } = await enrol('solo-co', only);
    expect(await platform.listTenantAdmins(principal, tenant.id)).toEqual([
      expect.objectContaining({ id: only.id, mfaEnabled: true, status: 'ACTIVE' }),
    ]);

    const result = await platform.resetAdminMfa(principal, tenant.id, only.id, BODY, { ip: '203.0.113.9' });
    expect(result).toMatchObject({
      id: only.id,
      reenrolmentRequired: true,
      sessionsRevoked: 1,
      notified: { inApp: true, email: false },
    });
    expect(await getMfaStatus(only.id)).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    expect(await validateSession(token)).toBeNull();
    const back = await login({ workspace: 'solo-co', email: 'only@solo.test', password: TEST_PASSWORD });
    expect((await validateSession((back as { token: string }).token))!.mfaSetupRequired).toBe(true);

    const [inWorkspace] = await auditRows('auth.mfa_reset_by_admin');
    expect(inWorkspace).toMatchObject({
      tenantId: tenant.id,
      userId: root.id,
      entityId: only.id,
      ip: '203.0.113.9',
    });
    expect(inWorkspace!.newValue).toMatchObject({ via: 'platform', reason: BODY.reason });
    const [onPlatform] = await auditRows('platform.admin_mfa_reset');
    expect(onPlatform).toMatchObject({
      tenantId: null,
      userId: root.id,
      entityType: 'tenant',
      entityId: tenant.id,
    });
    expect(onPlatform!.newValue).toMatchObject({ userId: only.id, reason: BODY.reason });

    const notice = await ownerDb().notification.findFirstOrThrow({ where: { userId: only.id } });
    expect(notice).toMatchObject({ tenantId: tenant.id, type: 'security.mfa_reset' });
    expect(notice.body).toContain('aVn CMS support');
  });

  it('asks for the super admin’s password, resets only an admin of that agency, and only for a super admin', async () => {
    await enrol('solo-co', only);
    const counselor = await makeUser(tenant.id, 'COUNSELOR', 'c@solo.test');
    await enrol('solo-co', counselor);
    const other = await makeTenant('other-co');
    const otherAdmin = await makeUser(other.id, 'TENANT_ADMIN', 'admin@other.test');
    await enrol('other-co', otherAdmin);

    const wrong = await failure(
      platform.resetAdminMfa(principal, tenant.id, only.id, { ...BODY, currentPassword: 'nope' }),
    );
    expect(wrong?.code).toBe('VALIDATION_ERROR');
    // A counselor is the agency's own admins' to reset; an admin addressed through the wrong agency does not exist.
    expect((await failure(platform.resetAdminMfa(principal, tenant.id, counselor.id, BODY)))?.code).toBe(
      'VALIDATION_ERROR',
    );
    expect((await failure(platform.resetAdminMfa(principal, tenant.id, otherAdmin.id, BODY)))?.code).toBe(
      'NOT_FOUND',
    );
    expect(
      (await failure(platform.listTenantAdmins(principal, '00000000-0000-4000-8000-000000000000')))?.code,
    ).toBe('NOT_FOUND');

    // Not even a workspace admin of this agency.
    const adminLogin = await login({
      workspace: 'solo-co',
      email: 'only@solo.test',
      password: TEST_PASSWORD,
    });
    const adminPrincipal = (await validateSession((adminLogin as { token: string }).token))!;
    expect((await failure(platform.resetAdminMfa(adminPrincipal, tenant.id, only.id, BODY)))?.code).toBe(
      'FORBIDDEN',
    );
    expect((await failure(platform.listTenantAdmins(adminPrincipal, tenant.id)))?.code).toBe('FORBIDDEN');

    for (const person of [only, counselor, otherAdmin]) {
      expect(await getMfaStatus(person.id)).toMatchObject({ enabled: true });
    }
    expect(await auditRows('auth.mfa_reset_by_admin')).toHaveLength(0);
    expect(await auditRows('platform.admin_mfa_reset')).toHaveLength(0);
  });

  it('has nothing to do when two-step verification is already off', async () => {
    expect((await failure(platform.resetAdminMfa(principal, tenant.id, only.id, BODY)))?.code).toBe(
      'CONFLICT',
    );
    expect(await auditRows('platform.admin_mfa_reset')).toHaveLength(0);
  });
});
