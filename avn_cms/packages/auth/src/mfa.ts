import { randomInt } from 'node:crypto';

import { ownerDb } from '@avn-cms/db/owner';

import { auditAuth } from './audit';
import { decrypt, encrypt, keyedHash } from './crypto';
import { verifyPassword } from './password';
import { revokeOtherSessions, markMfaVerified } from './sessions';
import { generateTotpSecret, otpauthUrl, totpStep } from './totp';

/**
 * Two-step verification: an authenticator-app code (TOTP) at sign-in, with one-time recovery codes for
 * a lost phone.
 *
 * Protections: a code is good once (the newest accepted 30-second step is remembered), five wrong
 * codes in a row pause second-factor checks for a while (longer each time), recovery codes are stored
 * only as keyed hashes, turning it on needs the account password, and turning it on or off signs
 * every other device out.
 */

export class MfaAlreadyEnabled extends Error {
  constructor() {
    super('Two-step verification is already on. Turn it off with a current code first.');
    this.name = 'MfaAlreadyEnabled';
  }
}

export const RECOVERY_CODE_COUNT = 10;
/** Wrong second-factor codes in a row before checks pause. */
export const MAX_SECOND_FACTOR_FAILURES = 5;

// No 0/O/1/I/L: codes are read off a screen or a sheet of paper.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_LENGTH = 10;

/** `XXXXX-XXXXX`, 10 characters from a 31-letter alphabet (about 50 bits). */
export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < RECOVERY_LENGTH; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** The canonical form of what a person typed (case, spaces and the dash do not matter), or null. */
export function normalizeRecoveryCode(input: string): string | null {
  const raw = input.replace(/[\s-]/g, '').toUpperCase();
  return raw.length === RECOVERY_LENGTH && [...raw].every((c) => RECOVERY_ALPHABET.includes(c)) ? raw : null;
}

export type SecondFactorResult =
  | { ok: true; method: 'totp' | 'recovery'; recoveryCodesLeft: number }
  | { ok: false; reason: 'INVALID' | 'LOCKED'; retryAfterSeconds?: number };

const lockMinutes = (failures: number) =>
  failures >= MAX_SECOND_FACTOR_FAILURES ? Math.min(60, 5 * 2 ** (failures - MAX_SECOND_FACTOR_FAILURES)) : 0;

async function recoveryCodesLeft(userId: string): Promise<number> {
  return ownerDb().mfaRecoveryCode.count({ where: { userId, usedAt: null } });
}

/**
 * Checks a 6-digit code or a recovery code for a user who has two-step verification on, applying the
 * replay and attempt limits. Every caller (sign-in, turning it off, new recovery codes) goes through here.
 */
async function checkSecondFactor(
  user: {
    id: string;
    tenantId: string | null;
    mfaSecret: string | null;
    mfaEnabledAt: Date | null;
    mfaLockedUntil: Date | null;
    mfaFailedCount: number;
  },
  code: string,
): Promise<SecondFactorResult> {
  const db = ownerDb();
  const now = Date.now();
  if (!user.mfaSecret || !user.mfaEnabledAt) return { ok: false, reason: 'INVALID' };
  if (user.mfaLockedUntil && user.mfaLockedUntil.getTime() > now) {
    return {
      ok: false,
      reason: 'LOCKED',
      retryAfterSeconds: Math.ceil((user.mfaLockedUntil.getTime() - now) / 1000),
    };
  }

  const typed = code.trim();
  let method: 'totp' | 'recovery' | null = null;
  if (/^\d{6}$/.test(typed)) {
    const step = totpStep(decrypt(user.mfaSecret), typed, now);
    if (step !== null) {
      // A code is good once: only a step newer than the last accepted one passes (and concurrent
      // requests with the same code race on this update; one wins).
      const claimed = await db.user.updateMany({
        where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
        data: { mfaLastStep: step },
      });
      if (claimed.count === 1) method = 'totp';
    }
  } else {
    const recovery = normalizeRecoveryCode(typed);
    if (recovery) {
      const used = await db.mfaRecoveryCode.updateMany({
        where: { userId: user.id, codeHash: keyedHash(recovery), usedAt: null },
        data: { usedAt: new Date(now) },
      });
      if (used.count === 1) method = 'recovery';
    }
  }

  if (!method) {
    const failures = user.mfaFailedCount + 1;
    const minutes = lockMinutes(failures);
    await db.user.update({
      where: { id: user.id },
      data: {
        mfaFailedCount: failures,
        ...(minutes ? { mfaLockedUntil: new Date(now + minutes * 60_000) } : {}),
      },
    });
    await auditAuth({
      tenantId: user.tenantId,
      userId: user.id,
      action: minutes ? 'auth.mfa_locked' : 'auth.mfa_failed',
      newValue: { failures },
    });
    return minutes
      ? { ok: false, reason: 'LOCKED', retryAfterSeconds: minutes * 60 }
      : { ok: false, reason: 'INVALID' };
  }

  await db.user.update({ where: { id: user.id }, data: { mfaFailedCount: 0, mfaLockedUntil: null } });
  const left = await recoveryCodesLeft(user.id);
  if (method === 'recovery') {
    await auditAuth({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'auth.mfa_recovery_used',
      newValue: { left },
    });
  }
  return { ok: true, method, recoveryCodesLeft: left };
}

/** Replaces every recovery code with a fresh set and returns the codes (shown once). */
async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const db = ownerDb();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await db.$transaction([
    db.mfaRecoveryCode.deleteMany({ where: { userId } }),
    db.mfaRecoveryCode.createMany({
      data: codes.map((c) => ({ userId, codeHash: keyedHash(normalizeRecoveryCode(c)!) })),
    }),
  ]);
  return codes;
}

export async function getMfaStatus(userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
  const user = await ownerDb().user.findUniqueOrThrow({
    where: { id: userId },
    select: { mfaEnabledAt: true },
  });
  return {
    enabled: user.mfaEnabledAt !== null,
    recoveryCodesLeft: user.mfaEnabledAt ? await recoveryCodesLeft(userId) : 0,
  };
}

/**
 * Step 1 of enrolment: needs the account password (a stolen session alone cannot turn on a factor
 * the owner doesn't have), stores a new, not yet active secret and returns it for the QR code. Null
 * when the password is wrong. MFA turns on only after a valid code is confirmed (confirmMfa).
 */
export async function beginMfaEnrollment(
  userId: string,
  currentPassword: string,
): Promise<{ secret: string; otpauth: string } | null> {
  const db = ownerDb();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(user.passwordHash, currentPassword))) return null;
  // Re-enrolling must not be a way to drop an active factor without a code.
  if (user.mfaEnabledAt) throw new MfaAlreadyEnabled();
  const secret = generateTotpSecret();
  await db.user.update({ where: { id: userId }, data: { mfaSecret: encrypt(secret), mfaEnabledAt: null } });
  return { secret, otpauth: otpauthUrl(secret, user.email) };
}

/**
 * Step 2: a valid code turns two-step verification on, signs the other devices out (a session stolen
 * before this must not outlive it) and returns the one-time recovery codes. Null when the code is wrong.
 */
export async function confirmMfa(
  userId: string,
  sessionId: string,
  code: string,
): Promise<{ recoveryCodes: string[] } | null> {
  const db = ownerDb();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecret || user.mfaEnabledAt) return null;
  const step = totpStep(decrypt(user.mfaSecret), code.trim());
  if (step === null) return null;
  await db.user.update({
    where: { id: userId },
    data: { mfaEnabledAt: new Date(), mfaLastStep: step, mfaFailedCount: 0, mfaLockedUntil: null },
  });
  const recoveryCodes = await issueRecoveryCodes(userId);
  await markMfaVerified(sessionId);
  await revokeOtherSessions(userId, sessionId);
  await auditAuth({ tenantId: user.tenantId, userId, action: 'auth.mfa_enabled' });
  return { recoveryCodes };
}

/** Second factor at sign-in: a 6-digit code, or a recovery code. */
export async function verifyMfaForSession(
  userId: string,
  sessionId: string,
  code: string,
): Promise<SecondFactorResult> {
  const user = await ownerDb().user.findUniqueOrThrow({ where: { id: userId } });
  const result = await checkSecondFactor(user, code);
  if (result.ok) await markMfaVerified(sessionId);
  return result;
}

/** Turning it off needs a current code (or a recovery code) and signs the other devices out. */
export async function disableMfa(
  userId: string,
  sessionId: string,
  code: string,
): Promise<SecondFactorResult> {
  const db = ownerDb();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const result = await checkSecondFactor(user, code);
  if (!result.ok) return result;
  await db.user.update({
    where: { id: userId },
    data: { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null },
  });
  await db.mfaRecoveryCode.deleteMany({ where: { userId } });
  await revokeOtherSessions(userId, sessionId);
  await auditAuth({ tenantId: user.tenantId, userId, action: 'auth.mfa_disabled' });
  return result;
}

/** A new set of recovery codes (the old ones stop working). Needs a current code. */
export async function regenerateRecoveryCodes(
  userId: string,
  code: string,
): Promise<{ ok: true; recoveryCodes: string[] } | Extract<SecondFactorResult, { ok: false }>> {
  const user = await ownerDb().user.findUniqueOrThrow({ where: { id: userId } });
  const result = await checkSecondFactor(user, code);
  if (!result.ok) return result;
  const recoveryCodes = await issueRecoveryCodes(userId);
  await auditAuth({ tenantId: user.tenantId, userId, action: 'auth.mfa_recovery_regenerated' });
  return { ok: true, recoveryCodes };
}
