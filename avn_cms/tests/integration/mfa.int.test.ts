import {
  MAX_SECOND_FACTOR_FAILURES,
  MAX_SESSIONS_PER_USER,
  beginMfaEnrollment,
  confirmMfa,
  disableMfa,
  getMfaStatus,
  login,
  purgeAuthRecords,
  regenerateRecoveryCodes,
  totpAt,
  validateSession,
  verifyMfaForSession,
} from '@avn-cms/auth';
import { resetConfigForTests } from '@avn-cms/config';
import { ownerDb } from '@avn-cms/db/owner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_PASSWORD, makeTenant, makeUser, resetData } from '../fixtures/factory';

/**
 * Two-step verification and session lifetime against the real database: a code is good once, wrong
 * codes pause checks, recovery codes work once and are never stored in the clear, and turning it on
 * or off signs the other devices out.
 */
describe('two-step verification', () => {
  let tenant: { id: string; slug: string };
  let user: { id: string; email: string };

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('mfa-co');
    user = await makeUser(tenant.id, 'COUNSELOR', 'c@mfa.test');
  });
  afterEach(() => vi.useRealTimers());

  const creds = () => ({ workspace: 'mfa-co', email: 'c@mfa.test', password: TEST_PASSWORD });
  const session = async () => {
    const res = await login(creds());
    if (!res.ok) throw new Error('login failed');
    return { token: res.token, principal: (await validateSession(res.token))! };
  };
  /** Turns it on for the user; returns the secret, the recovery codes and the signed-in session. */
  async function enrol() {
    const first = await session();
    const begun = await beginMfaEnrollment(user.id, TEST_PASSWORD);
    const confirmed = await confirmMfa(user.id, first.principal.sessionId, totpAt(begun!.secret, Date.now()));
    return { secret: begun!.secret, codes: confirmed!.recoveryCodes, first };
  }
  /** A moment `seconds` later (only the clock is faked, so the database keeps working). */
  const later = (seconds: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + seconds * 1000);
  };
  /** A sign-in that is waiting for its second factor. */
  const pending = async () => {
    const second = await login(creds());
    if (!second.ok || !second.mfaRequired) throw new Error('expected a second factor');
    return { token: second.token, sessionId: (await validateSession(second.token))!.sessionId };
  };

  it('turning it on needs the password, a valid code, and returns ten recovery codes once', async () => {
    const { principal } = await session();
    expect(await beginMfaEnrollment(user.id, 'not-the-password')).toBeNull();

    const begun = (await beginMfaEnrollment(user.id, TEST_PASSWORD))!;
    expect(await confirmMfa(user.id, principal.sessionId, '000000')).toBeNull();
    expect(await getMfaStatus(user.id)).toEqual({ enabled: false, recoveryCodesLeft: 0 });

    const confirmed = (await confirmMfa(user.id, principal.sessionId, totpAt(begun.secret, Date.now())))!;
    expect(confirmed.recoveryCodes).toHaveLength(10);
    for (const code of confirmed.recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(new Set(confirmed.recoveryCodes).size).toBe(10);
    expect(await getMfaStatus(user.id)).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    // Only a keyed hash is kept: nothing in the table is a code, and none can be guessed from it.
    const stored = await ownerDb().mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      for (const code of confirmed.recoveryCodes) {
        expect(row.codeHash).not.toContain(code.replace('-', ''));
      }
    }

    // It can't be turned on twice, and re-enrolling can't be used to drop the factor.
    await expect(beginMfaEnrollment(user.id, TEST_PASSWORD)).rejects.toThrow(/already on/);
  });

  it('turning it on signs the other devices out', async () => {
    const other = await session();
    const current = await session();
    const begun = (await beginMfaEnrollment(user.id, TEST_PASSWORD))!;
    await confirmMfa(user.id, current.principal.sessionId, totpAt(begun.secret, Date.now()));
    expect(await validateSession(other.token)).toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
  });

  it('sign-in then needs a code, and a code works once', async () => {
    const { secret } = await enrol();
    const waiting = await pending();
    expect((await validateSession(waiting.token))!.mfaVerified).toBe(false);

    // The code used to turn it on belongs to the step already spent; the next step's code is fresh.
    const code = totpAt(secret, Date.now() + 30_000);
    expect(await verifyMfaForSession(user.id, waiting.sessionId, code)).toMatchObject({
      ok: true,
      method: 'totp',
    });
    expect((await validateSession(waiting.token))!.mfaVerified).toBe(true);

    // The same code again, on a new sign-in, is refused (a code seen by someone else is useless).
    const again = await pending();
    expect(await verifyMfaForSession(user.id, again.sessionId, code)).toMatchObject({
      ok: false,
      reason: 'INVALID',
    });
    // So is the code that confirmed the set-up.
    expect(await verifyMfaForSession(user.id, again.sessionId, totpAt(secret, Date.now()))).toMatchObject({
      ok: false,
    });
  });

  it('a fresh code from a later step is accepted', async () => {
    const { secret } = await enrol();
    later(120);
    const waiting = await pending();
    expect(await verifyMfaForSession(user.id, waiting.sessionId, totpAt(secret, Date.now()))).toMatchObject({
      ok: true,
    });
  });

  it('five wrong codes in a row pause the checks, even for the right code', async () => {
    const { secret } = await enrol();
    const waiting = await pending();
    for (let i = 1; i < MAX_SECOND_FACTOR_FAILURES; i++) {
      expect(await verifyMfaForSession(user.id, waiting.sessionId, '000000')).toEqual({
        ok: false,
        reason: 'INVALID',
      });
    }
    const locked = await verifyMfaForSession(user.id, waiting.sessionId, '000000');
    expect(locked).toMatchObject({ ok: false, reason: 'LOCKED' });
    expect(locked.ok === false && locked.retryAfterSeconds).toBeGreaterThan(0);

    // The correct code is refused while paused, and the pause is recorded.
    const good = totpAt(secret, Date.now() + 30_000);
    expect(await verifyMfaForSession(user.id, waiting.sessionId, good)).toMatchObject({
      ok: false,
      reason: 'LOCKED',
    });
    const audit = await ownerDb().auditLog.findMany({
      where: { userId: user.id, action: { startsWith: 'auth.mfa_' } },
    });
    expect(audit.map((a) => a.action)).toContain('auth.mfa_locked');

    // Once the pause is over the right code works and the counter starts again.
    await ownerDb().user.update({
      where: { id: user.id },
      data: { mfaLockedUntil: new Date(Date.now() - 1000) },
    });
    expect(await verifyMfaForSession(user.id, waiting.sessionId, good)).toMatchObject({ ok: true });
    expect((await ownerDb().user.findUniqueOrThrow({ where: { id: user.id } })).mfaFailedCount).toBe(0);
  });

  it('a recovery code signs in once, in any case or spacing, and the count goes down', async () => {
    const { codes } = await enrol();
    const waiting = await pending();
    const typed = codes[0]!.toLowerCase().replace('-', ' ');
    expect(await verifyMfaForSession(user.id, waiting.sessionId, typed)).toEqual({
      ok: true,
      method: 'recovery',
      recoveryCodesLeft: 9,
    });
    expect((await validateSession(waiting.token))!.mfaVerified).toBe(true);

    const again = await pending();
    expect(await verifyMfaForSession(user.id, again.sessionId, codes[0]!)).toMatchObject({
      ok: false,
      reason: 'INVALID',
    });
    expect(await verifyMfaForSession(user.id, again.sessionId, codes[1]!)).toMatchObject({
      ok: true,
      recoveryCodesLeft: 8,
    });
    expect(
      (await ownerDb().auditLog.findMany({ where: { userId: user.id, action: 'auth.mfa_recovery_used' } }))
        .length,
    ).toBe(2);
  });

  it('a made-up recovery code counts as a wrong code', async () => {
    await enrol();
    const waiting = await pending();
    expect(await verifyMfaForSession(user.id, waiting.sessionId, 'AAAAA-AAAAA')).toMatchObject({ ok: false });
    expect(await verifyMfaForSession(user.id, waiting.sessionId, 'short')).toMatchObject({ ok: false });
    expect((await ownerDb().user.findUniqueOrThrow({ where: { id: user.id } })).mfaFailedCount).toBe(2);
  });

  it('new recovery codes replace the old ones and need a current code', async () => {
    const { secret, codes } = await enrol();
    later(120);
    expect(await regenerateRecoveryCodes(user.id, '000000')).toMatchObject({ ok: false });
    const fresh = await regenerateRecoveryCodes(user.id, totpAt(secret, Date.now()));
    if (!fresh.ok) throw new Error('expected new codes');
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(fresh.recoveryCodes.some((c) => codes.includes(c))).toBe(false);

    const waiting = await pending();
    expect(await verifyMfaForSession(user.id, waiting.sessionId, codes[0]!)).toMatchObject({ ok: false });
    expect(await verifyMfaForSession(user.id, waiting.sessionId, fresh.recoveryCodes[0]!)).toMatchObject({
      ok: true,
      recoveryCodesLeft: 9,
    });
  });

  it('turning it off needs a code, removes the recovery codes and signs the other devices out', async () => {
    const { secret, codes, first } = await enrol();
    const current = await session(); // a second device, signed in after the factor was added
    const waiting = await pending(); // and a third, still waiting for its code
    expect(await disableMfa(user.id, current.principal.sessionId, '000000')).toMatchObject({ ok: false });
    expect(await getMfaStatus(user.id)).toMatchObject({ enabled: true });

    // A recovery code works for this too (the phone is lost).
    expect(await disableMfa(user.id, current.principal.sessionId, codes[2]!)).toMatchObject({ ok: true });
    expect(await getMfaStatus(user.id)).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    expect(await ownerDb().mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
    expect(await validateSession(first.token)).toBeNull();
    expect(await validateSession(waiting.token)).toBeNull();
    expect(await validateSession(current.token)).not.toBeNull();
    // Back to a plain sign-in, and the old secret is gone.
    expect(await login(creds())).toMatchObject({ ok: true, mfaRequired: false });
    expect(
      await verifyMfaForSession(user.id, current.principal.sessionId, totpAt(secret, Date.now())),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe('roles that must use two-step verification', () => {
  beforeEach(async () => {
    await resetData();
  });
  afterEach(() => {
    delete process.env['MFA_REQUIRED_ROLES'];
    resetConfigForTests();
  });

  it('are told to set it up until they have', async () => {
    process.env['MFA_REQUIRED_ROLES'] = 'SUPER_ADMIN, TENANT_ADMIN';
    resetConfigForTests();
    const tenant = await makeTenant('req-co');
    const admin = await makeUser(tenant.id, 'TENANT_ADMIN', 'a@req.test');
    const counselor = await makeUser(tenant.id, 'COUNSELOR', 'c@req.test');
    const signIn = async (email: string) => {
      const res = await login({ workspace: 'req-co', email, password: TEST_PASSWORD });
      if (!res.ok) throw new Error('login failed');
      return (await validateSession(res.token))!;
    };

    const adminSession = await signIn('a@req.test');
    expect(adminSession.mfaSetupRequired).toBe(true);
    expect((await signIn('c@req.test')).mfaSetupRequired).toBe(false);

    const begun = (await beginMfaEnrollment(admin.id, TEST_PASSWORD))!;
    await confirmMfa(admin.id, adminSession.sessionId, totpAt(begun.secret, Date.now()));
    expect(counselor.id).toBeTruthy();
    const after = await login({ workspace: 'req-co', email: 'a@req.test', password: TEST_PASSWORD });
    expect(after).toMatchObject({ ok: true, mfaRequired: true });
  });
});

describe('session lifetime', () => {
  beforeEach(async () => {
    await resetData();
  });

  it('platform sessions end sooner than workspace sessions', async () => {
    const tenant = await makeTenant('life-co');
    await makeUser(tenant.id, 'COUNSELOR', 'c@life.test');
    const root = await makeUser(null, 'SUPER_ADMIN', 'root@platform.test');
    const worker = await login({ workspace: 'life-co', email: 'c@life.test', password: TEST_PASSWORD });
    const platform = await login({ workspace: '', email: 'root@platform.test', password: TEST_PASSWORD });
    if (!worker.ok || !platform.ok) throw new Error('login failed');
    const hours = (d: Date) => (d.getTime() - Date.now()) / 3_600_000;
    expect(hours(worker.expiresAt)).toBeGreaterThan(160); // the configured week
    expect(hours(platform.expiresAt)).toBeLessThanOrEqual(12);

    // Four hours idle ends a platform session; a workspace session is still good.
    const idle = new Date(Date.now() - 5 * 3_600_000);
    await ownerDb().session.updateMany({ data: { lastSeenAt: idle } });
    expect(await validateSession(platform.token)).toBeNull();
    expect(await validateSession(worker.token)).not.toBeNull();
    expect(root.id).toBeTruthy();
  });

  it('keeps at most a set number of signed-in devices per person', async () => {
    const tenant = await makeTenant('cap-co');
    const user = await makeUser(tenant.id, 'COUNSELOR', 'c@cap.test');
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 3; i++) {
      const res = await login({ workspace: 'cap-co', email: 'c@cap.test', password: TEST_PASSWORD });
      if (!res.ok) throw new Error('login failed');
      tokens.push(res.token);
    }
    const live = await ownerDb().session.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(MAX_SESSIONS_PER_USER);
    expect(await validateSession(tokens[0]!)).toBeNull(); // the oldest went
    expect(await validateSession(tokens.at(-1)!)).not.toBeNull();
  });

  it('removes sessions and reset links that ended long ago, and only those', async () => {
    const tenant = await makeTenant('purge-co');
    const user = await makeUser(tenant.id, 'COUNSELOR', 'c@purge.test');
    const db = ownerDb();
    const day = 86_400_000;
    const make = (data: { expiresAt: Date; revokedAt?: Date }) =>
      db.session.create({
        data: { userId: user.id, tokenHash: `h${Math.random()}`, csrfSecret: 'x', ...data },
      });
    const old = await make({ expiresAt: new Date(Date.now() - 40 * day) });
    const oldRevoked = await make({
      expiresAt: new Date(Date.now() + day),
      revokedAt: new Date(Date.now() - 40 * day),
    });
    const recent = await make({ expiresAt: new Date(Date.now() - 2 * day) });
    const live = await make({ expiresAt: new Date(Date.now() + day) });
    const token = (hash: string, expiresAt: Date, usedAt?: Date) =>
      db.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hash, expiresAt, ...(usedAt ? { usedAt } : {}) },
      });
    await token('old-token', new Date(Date.now() - 9 * day));
    await token('recent-token', new Date(Date.now() - day));
    await token('open-token', new Date(Date.now() + day));

    expect(await purgeAuthRecords()).toEqual({ sessions: 2, resetTokens: 1 });
    const left = (await db.session.findMany({ select: { id: true } })).map((s) => s.id).sort();
    expect(left).toEqual([recent.id, live.id].sort());
    expect([old.id, oldRevoked.id].some((id) => left.includes(id))).toBe(false);
  });
});
