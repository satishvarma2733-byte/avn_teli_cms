import { hashPassword, issueSetPasswordToken, randomToken, revokeAllSessions } from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import { withTenant, type Prisma, type RoleCode } from '@avn-cms/db';
import type { z } from 'zod';

import { ELIGIBLE_ROLES } from '../assignments/assignment.repository';
import { sendMail } from '../communications/email';
import { authorize } from '../policy/index';
import type { transferLeadsSchema, userCreateSchema, userUpdateSchema } from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, forbidden, invalid, notFound } from '../shared/errors';
import { toE164 } from '../shared/phone';

/** Users workspace (PAGES_AND_ROUTES /users). Tenant admins only; privilege changes are audited. */

export async function listUsers(ctx: Ctx) {
  authorize(ctx, 'user:list');
  return withTenant(ctx.tenantId, async (db) => {
    const users = await db.user.findMany({
      where: { deletedAt: null },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        phoneE164: true,
        roleCode: true,
        status: true,
        lastLoginAt: true,
        mfaEnabledAt: true,
        createdAt: true,
      },
    });
    const counts = await db.leadAssignment.groupBy({
      by: ['assigneeId'],
      where: { isActive: true },
      _count: { _all: true },
    });
    const open = await db.followUp.groupBy({
      by: ['assigneeId'],
      where: { completedAt: null },
      _count: { _all: true },
    });
    const byUser = new Map(counts.map((c) => [c.assigneeId, c._count._all]));
    const openBy = new Map(open.map((c) => [c.assigneeId, c._count._all]));
    return users.map((u) => ({
      ...u,
      mfaEnabled: u.mfaEnabledAt !== null,
      activeLeads: byUser.get(u.id) ?? 0,
      openCalls: openBy.get(u.id) ?? 0,
    }));
  });
}

async function sendSetPasswordLink(email: string, name: string, token: string, kind: 'invite' | 'reset') {
  const link = `${getConfig().APP_URL}/reset-password/${encodeURIComponent(token)}`;
  const subject = kind === 'invite' ? 'You have been invited to aVn CMS' : 'Set a new aVn CMS password';
  const text =
    kind === 'invite'
      ? `Hi ${name},\n\nAn administrator added you to aVn CMS. Choose your password here (the link works once and expires in 72 hours):\n${link}`
      : `Hi ${name},\n\nAn administrator reset your aVn CMS password. Choose a new one here (the link works once and expires in 72 hours):\n${link}`;
  const mail = await sendMail(email, subject, text);
  // When email isn't configured the admin gets the link to pass on — nothing pretends it was sent.
  return mail.sent ? { emailed: true as const } : { emailed: false as const, link, reason: mail.reason };
}

export async function createUser(ctx: Ctx, dto: z.output<typeof userCreateSchema>) {
  authorize(ctx, 'user:manage');
  const phoneE164 = dto.phone ? toE164(dto.phone) : null;
  if (dto.phone && !phoneE164)
    throw invalid('Enter a valid phone number.', { fields: { phone: 'Enter a valid phone number.' } });
  const user = await withTenant(ctx.tenantId, async (db) => {
    if (await db.user.findFirst({ where: { email: dto.email }, select: { id: true } })) {
      throw conflict('Someone in this workspace already uses that email.', {
        fields: { email: 'Already in use.' },
      });
    }
    const created = await db.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        phoneE164,
        roleCode: dto.role,
        // Unusable until the invitee sets their own password via the link.
        passwordHash: await hashPassword(randomToken()),
      } as Prisma.UserUncheckedCreateInput,
      select: { id: true, name: true, email: true, roleCode: true },
    });
    await audit(db, ctx, 'user.create', 'user', created.id, undefined, {
      email: created.email,
      role: created.roleCode,
    });
    return created;
  });
  const token = await issueSetPasswordToken(user.id);
  return { ...user, invite: await sendSetPasswordLink(user.email, user.name, token, 'invite') };
}

async function countActiveAdmins(db: Parameters<Parameters<typeof withTenant>[1]>[0], excludeId?: string) {
  return db.user.count({
    where: {
      roleCode: 'TENANT_ADMIN',
      status: 'ACTIVE',
      deletedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

export async function updateUser(ctx: Ctx, id: string, dto: z.output<typeof userUpdateSchema>) {
  authorize(ctx, 'user:manage');
  if (id === ctx.userId && (dto.role !== undefined || dto.status === 'DISABLED')) {
    throw forbidden('You can’t change your own role or disable yourself. Ask another admin.');
  }
  let disabled = false;
  const result = await withTenant(ctx.tenantId, async (db) => {
    const user = await db.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, roleCode: true, status: true, name: true },
    });
    if (!user) throw notFound('User');
    const losingAdmin =
      user.roleCode === 'TENANT_ADMIN' &&
      ((dto.role && dto.role !== 'TENANT_ADMIN') || dto.status === 'DISABLED');
    if (losingAdmin && (await countActiveAdmins(db, id)) === 0)
      throw conflict('A workspace needs at least one active admin.');
    const data: Prisma.UserUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) {
      const p = dto.phone ? toE164(dto.phone) : null;
      if (dto.phone && !p)
        throw invalid('Enter a valid phone number.', { fields: { phone: 'Enter a valid phone number.' } });
      data.phoneE164 = p;
    }
    if (dto.role !== undefined) data.roleCode = dto.role as RoleCode;
    if (dto.status !== undefined) data.status = dto.status;
    await db.user.updateMany({ where: { id }, data });
    const privilege = dto.role !== undefined && dto.role !== user.roleCode;
    await audit(
      db,
      ctx,
      privilege
        ? 'user.role_change'
        : dto.status && dto.status !== user.status
          ? `user.${dto.status === 'DISABLED' ? 'disable' : 'enable'}`
          : 'user.update',
      'user',
      id,
      { role: user.roleCode, status: user.status, name: user.name },
      data,
    );
    disabled = dto.status === 'DISABLED' && user.status !== 'DISABLED';
    return { id };
  });
  if (disabled || dto.role !== undefined) await revokeAllSessions(id); // new permissions take effect at next sign-in
  return result;
}

export async function adminResetPassword(ctx: Ctx, id: string) {
  authorize(ctx, 'user:resetPassword');
  const user = await withTenant(ctx.tenantId, async (db) => {
    const u = await db.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, email: true, name: true },
    });
    if (!u) throw notFound('User');
    await audit(db, ctx, 'user.password_reset_by_admin', 'user', id);
    return u;
  });
  const token = await issueSetPasswordToken(user.id);
  await revokeAllSessions(user.id);
  return sendSetPasswordLink(user.email, user.name, token, 'reset');
}

/** Transfer-on-delete (RBAC + SCHEMA): move every active assignment and open call to another user. */
export async function transferLeads(ctx: Ctx, fromId: string, dto: z.output<typeof transferLeadsSchema>) {
  authorize(ctx, 'user:manage');
  if (fromId === dto.toUserId) throw invalid('Choose a different person.');
  return withTenant(
    ctx.tenantId,
    async (db) => {
      const from = await db.user.findFirst({ where: { id: fromId, deletedAt: null }, select: { id: true } });
      const to = await db.user.findFirst({
        where: { id: dto.toUserId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true, name: true, roleCode: true },
      });
      if (!from) throw notFound('User');
      if (!to)
        throw invalid('Choose an active user to receive the leads.', {
          fields: { toUserId: 'Not an active user.' },
        });
      const assignments = await db.leadAssignment.findMany({ where: { assigneeId: fromId, isActive: true } });
      let moved = 0;
      for (const a of assignments) {
        if (!ELIGIBLE_ROLES[a.roleFunction].includes(to.roleCode)) {
          throw invalid(
            `${to.name} can’t hold ${a.roleFunction === 'COUNSELOR' ? 'counselor' : 'telecaller'} assignments. Choose someone with that role.`,
          );
        }
        await db.leadAssignment.updateMany({
          where: { id: a.id },
          data: { isActive: false, endedAt: new Date() },
        });
        const existing = await db.leadAssignment.findFirst({
          where: { leadId: a.leadId, roleFunction: a.roleFunction, isActive: true },
        });
        if (!existing) {
          await db.leadAssignment.create({
            data: {
              leadId: a.leadId,
              assigneeId: to.id,
              roleFunction: a.roleFunction,
              assignedById: ctx.userId,
            } as Prisma.LeadAssignmentUncheckedCreateInput,
          });
        }
        moved++;
      }
      const calls = await db.followUp.updateMany({
        where: { assigneeId: fromId, completedAt: null },
        data: { assigneeId: to.id },
      });
      await audit(db, ctx, 'user.transfer_leads', 'user', fromId, undefined, {
        toUserId: to.id,
        assignments: moved,
        openCalls: calls.count,
      });
      return { assignments: moved, openCalls: calls.count };
    },
    { timeoutMs: 120_000 },
  );
}

/** Soft delete. Refused while the user still owns leads or calls (transfer first). */
export async function deleteUser(ctx: Ctx, id: string) {
  authorize(ctx, 'user:delete');
  if (id === ctx.userId) throw forbidden('You can’t delete your own account.');
  await withTenant(ctx.tenantId, async (db) => {
    const user = await db.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, email: true, roleCode: true },
    });
    if (!user) throw notFound('User');
    const owned = await db.leadAssignment.count({ where: { assigneeId: id, isActive: true } });
    const calls = await db.followUp.count({ where: { assigneeId: id, completedAt: null } });
    if (owned || calls)
      throw conflict(`Transfer ${owned} lead(s) and ${calls} open call(s) to someone else first.`, {
        owned,
        calls,
      });
    if (user.roleCode === 'TENANT_ADMIN' && (await countActiveAdmins(db, id)) === 0)
      throw conflict('A workspace needs at least one active admin.');
    await db.user.updateMany({ where: { id }, data: { deletedAt: new Date(), status: 'DISABLED' } });
    await audit(db, ctx, 'user.delete', 'user', id, { email: user.email, role: user.roleCode });
  });
  await revokeAllSessions(id);
  return { id };
}
