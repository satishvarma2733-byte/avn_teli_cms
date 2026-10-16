import { ownerDb } from '@avn-cms/db/owner';

import { auditAuth } from './audit';
import { decrypt, encrypt } from './crypto';
import { markMfaVerified } from './sessions';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp';

/**
 * Step 1 of enrolment: store a new (not yet active) secret and return it for the QR code.
 * MFA turns on only after a valid code is confirmed (confirmMfa).
 */
export class MfaAlreadyEnabled extends Error {
  constructor() {
    super('Two-step verification is already on. Turn it off with a current code first.');
    this.name = 'MfaAlreadyEnabled';
  }
}

export async function beginMfaEnrollment(userId: string): Promise<{ secret: string; otpauth: string }> {
  const db = ownerDb();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  // Re-enrolling must not be a way to drop an active factor without a code.
  if (user.mfaEnabledAt) throw new MfaAlreadyEnabled();
  const secret = generateTotpSecret();
  await db.user.update({ where: { id: userId }, data: { mfaSecret: encrypt(secret), mfaEnabledAt: null } });
  return { secret, otpauth: otpauthUrl(secret, user.email) };
}

export async function confirmMfa(userId: string, sessionId: string, code: string): Promise<boolean> {
  const db = ownerDb();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecret || !verifyTotp(decrypt(user.mfaSecret), code)) return false;
  await db.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date() } });
  await markMfaVerified(sessionId);
  await auditAuth({ tenantId: user.tenantId, userId, action: 'auth.mfa_enabled' });
  return true;
}

/** Second factor at sign-in. */
export async function verifyMfaForSession(userId: string, sessionId: string, code: string): Promise<boolean> {
  const user = await ownerDb().user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecret || !user.mfaEnabledAt) return false;
  if (!verifyTotp(decrypt(user.mfaSecret), code)) {
    await auditAuth({ tenantId: user.tenantId, userId, action: 'auth.mfa_failed' });
    return false;
  }
  await markMfaVerified(sessionId);
  return true;
}

export async function disableMfa(userId: string, code: string): Promise<boolean> {
  const db = ownerDb();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.mfaSecret || !user.mfaEnabledAt || !verifyTotp(decrypt(user.mfaSecret), code)) return false;
  await db.user.update({ where: { id: userId }, data: { mfaSecret: null, mfaEnabledAt: null } });
  await auditAuth({ tenantId: user.tenantId, userId, action: 'auth.mfa_disabled' });
  return true;
}
