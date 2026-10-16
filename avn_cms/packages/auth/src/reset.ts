import { ownerDb } from '@avn-cms/db/owner';
import { z } from 'zod';

import { auditAuth } from './audit';
import { randomToken, sha256 } from './crypto';
import { hashPassword, passwordSchema, verifyPassword } from './password';
import { revokeAllSessions, revokeOtherSessions } from './sessions';

const RESET_TTL_MS = 60 * 60_000;

export const forgotPasswordSchema = z.object({
  workspace: z
    .string()
    .trim()
    .toLowerCase()
    .max(60)
    .regex(/^[a-z0-9-]*$/)
    .default(''),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(100),
  password: passwordSchema,
});

/**
 * Creates a single-use reset token (1 hour) if the account exists. The caller emails the
 * link and always answers the same way, so the response never reveals whether the account exists.
 */
export async function requestPasswordReset(
  input: z.infer<typeof forgotPasswordSchema>,
): Promise<{ token: string; email: string; name: string } | null> {
  const db = ownerDb();
  let tenantId: string | null = null;
  if (input.workspace) {
    const tenant = await db.tenant.findUnique({ where: { slug: input.workspace } });
    if (!tenant || tenant.status === 'SUSPENDED') return null;
    tenantId = tenant.id;
  }
  const user = await db.user.findFirst({
    where: { tenantId, email: input.email, deletedAt: null, status: 'ACTIVE' },
  });
  if (!user) return null;

  // Older unused tokens stop working when a new one is issued.
  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  const token = randomToken();
  await db.passwordResetToken.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });
  await auditAuth({ tenantId: user.tenantId, userId: user.id, action: 'auth.password_reset_requested' });
  return { token, email: user.email, name: user.name };
}

/**
 * Admin-initiated: a single-use "set your password" token for a user (new-user invite or an
 * admin password reset). Older unused tokens stop working.
 */
export async function issueSetPasswordToken(userId: string, ttlHours = 72): Promise<string> {
  const db = ownerDb();
  await db.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  const token = randomToken();
  await db.passwordResetToken.create({
    data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlHours * 3_600_000) },
  });
  return token;
}

/** Sets the new password, burns the token and signs the user out everywhere. */
export async function resetPassword(input: z.infer<typeof resetPasswordSchema>): Promise<boolean> {
  const db = ownerDb();
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: sha256(input.token) },
    include: { user: true },
  });
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) return false;

  const claimed = await db.passwordResetToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return false; // a concurrent request used it first

  await db.user.update({
    where: { id: record.userId },
    data: { passwordHash: await hashPassword(input.password), failedLoginCount: 0, lockedUntil: null },
  });
  await revokeAllSessions(record.userId);
  await auditAuth({ tenantId: record.user.tenantId, userId: record.userId, action: 'auth.password_reset' });
  return true;
}

/** Signed-in password change: requires the current password; signs out other devices. */
export async function changePassword(input: {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<boolean> {
  const db = ownerDb();
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user || !(await verifyPassword(user.passwordHash, input.currentPassword))) return false;
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });
  await revokeOtherSessions(user.id, input.currentSessionId);
  await auditAuth({ tenantId: user.tenantId, userId: user.id, action: 'auth.password_changed' });
  return true;
}
