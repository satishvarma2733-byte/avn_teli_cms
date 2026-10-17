import { ownerDb } from '@avn-cms/db/owner';
import { z } from 'zod';

import { auditAuth } from './audit';
import { burnPasswordCheck, verifyPassword } from './password';
import { createSession } from './sessions';

export const loginSchema = z.object({
  /** Tenant slug. Empty for platform (super-admin) accounts. */
  workspace: z
    .string()
    .trim()
    .toLowerCase()
    .max(60)
    .regex(/^[a-z0-9-]*$/, 'Use letters, numbers and dashes.')
    .default(''),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  password: z.string().min(1, 'Enter your password.').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Failures before the account is locked; each further failure doubles the lock (max 60 min). */
const MAX_FAILURES = 5;

export type LoginResult =
  | { ok: true; token: string; csrfToken: string; expiresAt: Date; mfaRequired: boolean }
  | { ok: false; reason: 'INVALID_CREDENTIALS' | 'LOCKED' | 'SUSPENDED'; retryAfterSeconds?: number };

export async function login(
  input: LoginInput,
  meta: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<LoginResult> {
  const db = ownerDb();
  let tenantId: string | null = null;
  if (input.workspace) {
    const tenant = await db.tenant.findUnique({ where: { slug: input.workspace } });
    if (!tenant) {
      await burnPasswordCheck(input.password);
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }
    if (tenant.status === 'SUSPENDED') {
      await burnPasswordCheck(input.password);
      return { ok: false, reason: 'SUSPENDED' };
    }
    tenantId = tenant.id;
  }

  const user = await db.user.findFirst({
    where: { tenantId, email: input.email, deletedAt: null },
  });
  if (!user || (tenantId === null && user.roleCode !== 'SUPER_ADMIN')) {
    await burnPasswordCheck(input.password);
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil.getTime() > now) {
    await burnPasswordCheck(input.password);
    return {
      ok: false,
      reason: 'LOCKED',
      retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - now) / 1000),
    };
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid || user.status !== 'ACTIVE') {
    const failures = user.failedLoginCount + 1;
    const lockMinutes = failures >= MAX_FAILURES ? Math.min(60, 2 ** (failures - MAX_FAILURES)) : 0;
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failures,
        lockedUntil: lockMinutes ? new Date(now + lockMinutes * 60_000) : user.lockedUntil,
      },
    });
    await auditAuth({
      tenantId: user.tenantId,
      userId: user.id,
      action: lockMinutes ? 'auth.locked' : 'auth.login_failed',
      newValue: { failures },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(now) },
  });
  const mfaRequired = user.mfaEnabledAt !== null;
  const session = await createSession({
    userId: user.id,
    role: user.roleCode,
    mfaVerified: !mfaRequired,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  await auditAuth({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'auth.login',
    newValue: { mfaRequired },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true, ...session, mfaRequired };
}
