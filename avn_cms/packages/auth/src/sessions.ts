import { getConfig } from '@avn-cms/config';
import { ownerDb } from '@avn-cms/db/owner';

import type { Principal } from './context';
import { randomToken, sha256 } from './crypto';

/** lastSeenAt is written at most this often (keeps reads cheap). */
const TOUCH_MS = 5 * 60_000;
/** A person keeps at most this many signed-in devices; signing in on one more ends the oldest. */
export const MAX_SESSIONS_PER_USER = 20;

/**
 * How long a session may last. Everyone: ended after SESSION_TTL_HOURS, or 48 hours without a request.
 * Platform (super-admin) sessions can reach every workspace, so they end sooner: 12 hours in all and
 * 4 hours without a request.
 */
export function sessionLimits(role: string, ttlHours: number): { idleMs: number; maxMs: number } {
  const hour = 3_600_000;
  return role === 'SUPER_ADMIN'
    ? { idleMs: 4 * hour, maxMs: Math.min(ttlHours, 12) * hour }
    : { idleMs: 48 * hour, maxMs: ttlHours * hour };
}

export const SESSION_COOKIE = 'avn_session';
export const CSRF_COOKIE = 'avn_csrf';

export async function createSession(input: {
  userId: string;
  role: string;
  mfaVerified: boolean;
  ip?: string | undefined;
  userAgent?: string | undefined;
}): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + sessionLimits(input.role, getConfig().SESSION_TTL_HOURS).maxMs);
  const db = ownerDb();
  await db.session.create({
    data: {
      userId: input.userId,
      tokenHash: sha256(token),
      csrfSecret: csrfToken,
      mfaVerified: input.mfaVerified,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    },
  });
  // Keep only the newest MAX_SESSIONS_PER_USER sessions (a forgotten device does not pile up forever).
  const live = await db.session.findMany({
    where: { userId: input.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
    skip: MAX_SESSIONS_PER_USER,
  });
  if (live.length > 0) {
    await db.session.updateMany({
      where: { id: { in: live.map((s) => s.id) } },
      data: { revokedAt: new Date() },
    });
  }
  return { token, csrfToken, expiresAt };
}

/**
 * Resolves a session cookie to a principal, or null when the session is missing, expired,
 * idle too long, revoked, or its user/tenant is no longer allowed in.
 */
export async function validateSession(token: string | undefined): Promise<Principal | null> {
  if (!token || token.length > 100) return null;
  const db = ownerDb();
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { tenant: true } } },
  });
  if (!session || session.revokedAt) return null;
  const now = Date.now();
  const { user } = session;
  const { idleMs } = sessionLimits(user.roleCode, getConfig().SESSION_TTL_HOURS);
  if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > idleMs) return null;
  if (user.status !== 'ACTIVE' || user.deletedAt) return null;
  if (user.tenant && user.tenant.status === 'SUSPENDED') return null;

  if (now - session.lastSeenAt.getTime() > TOUCH_MS) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
  }

  let actingTenantId: string | null = null;
  if (user.roleCode === 'SUPER_ADMIN' && session.actingTenantId) actingTenantId = session.actingTenantId;

  return {
    sessionId: session.id,
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.roleCode,
    tenantId: user.tenantId,
    tenantName: user.tenant?.name ?? null,
    tenantSlug: user.tenant?.slug ?? null,
    actingTenantId,
    mfaEnabled: user.mfaEnabledAt !== null,
    mfaVerified: session.mfaVerified,
    mfaSetupRequired: user.mfaEnabledAt === null && getConfig().MFA_REQUIRED_ROLES.includes(user.roleCode),
    csrfToken: session.csrfSecret,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await ownerDb().session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** "Log out other devices": revokes every session of the user except the current one. */
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const res = await ownerDb().session.updateMany({
    where: { userId, revokedAt: null, id: { not: keepSessionId } },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await ownerDb().session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function listSessions(userId: string) {
  return ownerDb().session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true },
    orderBy: { lastSeenAt: 'desc' },
    take: 50,
  });
}

/** Revokes one of the user's own sessions; false if it isn't theirs. */
export async function revokeOwnSession(userId: string, sessionId: string): Promise<boolean> {
  const res = await ownerDb().session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count === 1;
}

export async function markMfaVerified(sessionId: string): Promise<void> {
  await ownerDb().session.update({ where: { id: sessionId }, data: { mfaVerified: true } });
}

export async function setActingTenant(sessionId: string, tenantId: string | null): Promise<void> {
  await ownerDb().session.update({ where: { id: sessionId }, data: { actingTenantId: tenantId } });
}
