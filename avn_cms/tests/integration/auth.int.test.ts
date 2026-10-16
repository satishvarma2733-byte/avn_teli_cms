import {
  confirmMfa,
  beginMfaEnrollment,
  login,
  requestPasswordReset,
  resetPassword,
  revokeOtherSessions,
  totpAt,
  validateSession,
  verifyMfaForSession,
} from '@avn-cms/auth';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeEach, describe, expect, it } from 'vitest';

import { TEST_PASSWORD, makeTenant, makeUser, resetData } from '../fixtures/factory';

describe('authentication', () => {
  let tenant: { id: string; slug: string };
  let user: { id: string; email: string };

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('acme');
    user = await makeUser(tenant.id, 'COUNSELOR', 'c@acme.test');
  });

  const creds = (over: Partial<{ workspace: string; email: string; password: string }> = {}) => ({
    workspace: 'acme',
    email: 'c@acme.test',
    password: TEST_PASSWORD,
    ...over,
  });

  it('logs in with workspace + email + password and yields a valid session', async () => {
    const res = await login(creds());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const principal = await validateSession(res.token);
    expect(principal).toMatchObject({
      userId: user.id,
      tenantId: tenant.id,
      role: 'COUNSELOR',
      mfaVerified: true,
    });
    // The token is never stored, only its hash.
    const stored = await ownerDb().session.findFirst({ where: { userId: user.id } });
    expect(stored!.tokenHash).not.toBe(res.token);
  });

  it('gives the same answer for wrong password, unknown email and unknown workspace', async () => {
    expect(await login(creds({ password: 'wrong-password-1' }))).toEqual({
      ok: false,
      reason: 'INVALID_CREDENTIALS',
    });
    expect(await login(creds({ email: 'nobody@acme.test' }))).toEqual({
      ok: false,
      reason: 'INVALID_CREDENTIALS',
    });
    expect(await login(creds({ workspace: 'nope' }))).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('a tenant user cannot sign in without their workspace (platform login)', async () => {
    expect(await login(creds({ workspace: '' }))).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('locks the account after 5 failures, even for the right password', async () => {
    for (let i = 0; i < 5; i++) await login(creds({ password: 'wrong-password-1' }));
    const res = await login(creds());
    expect(res).toMatchObject({ ok: false, reason: 'LOCKED' });
    const audit = await ownerDb().auditLog.findMany({ where: { userId: user.id, action: 'auth.locked' } });
    expect(audit).toHaveLength(1);
  });

  it('refuses suspended tenants and disabled users', async () => {
    await ownerDb().tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED' } });
    expect(await login(creds())).toEqual({ ok: false, reason: 'SUSPENDED' });
    await ownerDb().tenant.update({ where: { id: tenant.id }, data: { status: 'ACTIVE' } });
    await ownerDb().user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    expect(await login(creds())).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });

  it('a session dies when the user is disabled or the tenant suspended', async () => {
    const res = await login(creds());
    if (!res.ok) throw new Error('login failed');
    await ownerDb().tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED' } });
    expect(await validateSession(res.token)).toBeNull();
  });

  it('password reset: single use, expires, signs out everywhere', async () => {
    const first = await login(creds());
    if (!first.ok) throw new Error('login failed');
    const issued = await requestPasswordReset({ workspace: 'acme', email: 'c@acme.test' });
    expect(issued).not.toBeNull();
    expect(await requestPasswordReset({ workspace: 'acme', email: 'ghost@acme.test' })).toBeNull();

    expect(await resetPassword({ token: issued!.token, password: 'New-Password-456' })).toBe(true);
    expect(await resetPassword({ token: issued!.token, password: 'Another-Password-789' })).toBe(false);
    expect(await validateSession(first.token)).toBeNull();
    expect((await login(creds({ password: 'New-Password-456' }))).ok).toBe(true);
  });

  it('expired reset tokens are refused', async () => {
    const issued = await requestPasswordReset({ workspace: 'acme', email: 'c@acme.test' });
    await ownerDb().passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resetPassword({ token: issued!.token, password: 'New-Password-456' })).toBe(false);
  });

  it('MFA: enrol, then sign-in needs the second factor', async () => {
    const res = await login(creds());
    if (!res.ok) throw new Error('login failed');
    const p = (await validateSession(res.token))!;
    const { secret } = await beginMfaEnrollment(user.id);
    expect(await confirmMfa(user.id, p.sessionId, '000000')).toBe(false);
    expect(await confirmMfa(user.id, p.sessionId, totpAt(secret, Date.now()))).toBe(true);

    const second = await login(creds());
    expect(second).toMatchObject({ ok: true, mfaRequired: true });
    if (!second.ok) return;
    const pending = (await validateSession(second.token))!;
    expect(pending.mfaVerified).toBe(false);
    expect(await verifyMfaForSession(user.id, pending.sessionId, totpAt(secret, Date.now()))).toBe(true);
    expect((await validateSession(second.token))!.mfaVerified).toBe(true);

    // Re-enrolling can't be used to drop the active factor without a code.
    await expect(beginMfaEnrollment(user.id)).rejects.toThrow(/already on/);
    expect((await ownerDb().user.findUniqueOrThrow({ where: { id: user.id } })).mfaEnabledAt).not.toBeNull();
  });

  it('log out other devices keeps only the current session', async () => {
    const one = await login(creds());
    const two = await login(creds());
    if (!one.ok || !two.ok) throw new Error('login failed');
    const current = (await validateSession(two.token))!;
    expect(await revokeOtherSessions(user.id, current.sessionId)).toBe(1);
    expect(await validateSession(one.token)).toBeNull();
    expect(await validateSession(two.token)).not.toBeNull();
  });
});
