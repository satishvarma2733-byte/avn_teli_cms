import { randomBytes } from 'node:crypto';

import { randomToken, safeEqual, sha256 } from '@avn-cms/auth';
import { withTenant, type Prisma } from '@avn-cms/db';
import { ownerDb } from '@avn-cms/db/owner';

import { authorize } from '../policy/index';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { invalid, notFound } from '../shared/errors';

/** Old secret keeps working this long after a rotation, so senders can be updated without downtime. */
const ROTATION_OVERLAP_MS = 24 * 3_600_000;

export interface IntakeIdentity {
  credentialId: string;
  tenantId: string;
  defaultSourceId: string | null;
  rateLimitPerMin: number;
}

/**
 * Resolves Basic-auth credentials to a tenant. Cross-tenant lookup by username, so it uses the
 * owner client (like login); everything after this runs tenant-scoped.
 */
export async function authenticateIntake(username: string, secret: string): Promise<IntakeIdentity | null> {
  if (!/^wl_[a-z0-9]{8,32}$/.test(username) || secret.length < 20 || secret.length > 200) return null;
  const db = ownerDb();
  const cred = await db.intakeCredential.findUnique({
    where: { username },
    include: { tenant: { select: { status: true } } },
  });
  if (!cred || cred.revokedAt || cred.tenant.status === 'SUSPENDED') return null;
  const hash = sha256(secret);
  const current = safeEqual(hash, cred.secretHash);
  const previous =
    !current &&
    cred.previousSecretHash &&
    cred.previousValidUntil &&
    cred.previousValidUntil.getTime() > Date.now()
      ? safeEqual(hash, cred.previousSecretHash)
      : false;
  if (!current && !previous) return null;
  await db.intakeCredential.update({
    where: { id: cred.id },
    data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
  });
  return {
    credentialId: cred.id,
    tenantId: cred.tenantId,
    defaultSourceId: cred.defaultSourceId,
    rateLimitPerMin: cred.rateLimitPerMin,
  };
}

function newUsername(): string {
  return `wl_${randomBytes(6).toString('hex')}`;
}

const listSelect = {
  id: true,
  name: true,
  username: true,
  defaultSourceId: true,
  rateLimitPerMin: true,
  lastUsedAt: true,
  useCount: true,
  createdAt: true,
  revokedAt: true,
  previousValidUntil: true,
} satisfies Prisma.IntakeCredentialSelect;

export async function listCredentials(ctx: Ctx) {
  authorize(ctx, 'intakeCredential:manage');
  const rows = await withTenant(ctx.tenantId, (db) =>
    db.intakeCredential.findMany({
      select: listSelect,
      orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
    }),
  );
  return rows.map((r) => ({ ...r, useCount: Number(r.useCount) }));
}

/** The secret is returned exactly once, with the ready-made header (WEBLEADS_COMPATIBILITY §4). */
export async function createCredential(
  ctx: Ctx,
  input: { name: string; defaultSourceId?: string | null | undefined },
) {
  authorize(ctx, 'intakeCredential:manage');
  return withTenant(ctx.tenantId, async (db) => {
    if (input.defaultSourceId && !(await db.leadSource.findFirst({ where: { id: input.defaultSourceId } }))) {
      throw invalid('Choose a valid source.', { fields: { defaultSourceId: 'Unknown source.' } });
    }
    const secret = randomToken(32);
    const username = newUsername();
    const cred = await db.intakeCredential.create({
      data: {
        name: input.name,
        username,
        secretHash: sha256(secret),
        defaultSourceId: input.defaultSourceId ?? null,
        createdById: ctx.userId,
      } as Prisma.IntakeCredentialUncheckedCreateInput,
    });
    await audit(db, ctx, 'intake_credential.create', 'intake_credential', cred.id, undefined, {
      name: cred.name,
      username,
    });
    return {
      id: cred.id,
      name: cred.name,
      username,
      secret,
      authorization: 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64'),
    };
  });
}

export async function rotateCredential(ctx: Ctx, id: string) {
  authorize(ctx, 'intakeCredential:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const cred = await db.intakeCredential.findFirst({ where: { id, revokedAt: null } });
    if (!cred) throw notFound('Credential');
    const secret = randomToken(32);
    const previousValidUntil = new Date(Date.now() + ROTATION_OVERLAP_MS);
    await db.intakeCredential.updateMany({
      where: { id },
      data: { secretHash: sha256(secret), previousSecretHash: cred.secretHash, previousValidUntil },
    });
    await audit(db, ctx, 'intake_credential.rotate', 'intake_credential', id, undefined, {
      previousValidUntil,
    });
    return {
      id,
      username: cred.username,
      secret,
      previousValidUntil,
      authorization: 'Basic ' + Buffer.from(`${cred.username}:${secret}`).toString('base64'),
    };
  });
}

export async function revokeCredential(ctx: Ctx, id: string) {
  authorize(ctx, 'intakeCredential:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const res = await db.intakeCredential.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), previousSecretHash: null, previousValidUntil: null },
    });
    if (res.count === 0) throw notFound('Credential');
    await audit(db, ctx, 'intake_credential.revoke', 'intake_credential', id);
    return { id };
  });
}
