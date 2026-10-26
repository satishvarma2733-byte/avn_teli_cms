import {
  auditAuth,
  hashPassword,
  issueSetPasswordToken,
  randomToken,
  setActingTenant,
  type Principal,
} from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import type { Prisma, TenantStatus } from '@avn-cms/db';
import { ownerDb } from '@avn-cms/db/owner';
import { z } from 'zod';

import { starterRuleRows } from '../automation/starter';
import { sendMail } from '../communications/email';
import { conflict, forbidden, notFound } from '../shared/errors';
import { parsePlanLimits } from '../usage/usage.service';

/**
 * Super-admin platform module (RBAC: Super Admin, platform scope). Uses the owner client by
 * design — it is one of the two modules allowed to (MODULE_STRUCTURE). Platform metrics are
 * aggregated counts only (no tenant PII). Every action is audited.
 */

const SOURCES = [
  ['SHEET_DATA', 'Sheet Data'],
  ['GOOGLE_ADS', 'Google Ads'],
  ['META_ADS', 'Meta Ads'],
  ['DIRECT_CALL', 'Direct Call'],
  ['REFERENCE', 'Reference'],
  ['WEBSITE', 'Website'],
  ['WALK_IN', 'Walk-in'],
  ['OTHER', 'Other'],
] as const;

export const tenantCreateSchema = z.object({
  name: z.string().trim().min(2, 'Enter the agency name.').max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Lowercase letters, numbers and dashes.'),
  planCode: z.enum(['STARTER', 'PROFESSIONAL', 'ULTRA', 'ENTERPRISE']).default('STARTER'),
  adminName: z.string().trim().min(1, 'Enter the admin’s name.').max(200),
  adminEmail: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
});

export const tenantStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']) });
export const tenantPlanSchema = z.object({
  planCode: z.enum(['STARTER', 'PROFESSIONAL', 'ULTRA', 'ENTERPRISE']),
});

function requireSuperAdmin(p: Principal) {
  if (p.role !== 'SUPER_ADMIN') throw forbidden();
}

export async function listTenants(p: Principal) {
  requireSuperAdmin(p);
  const db = ownerDb();
  const tenants = await db.tenant.findMany({
    orderBy: { createdAt: 'desc' },
    include: { plan: { select: { name: true, code: true, limits: true } } },
  });
  const users = await db.user.groupBy({
    by: ['tenantId'],
    where: { deletedAt: null, status: 'ACTIVE' },
    _count: { _all: true },
  });
  const leads = await db.lead.groupBy({
    by: ['tenantId'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  const u = new Map(users.map((x) => [x.tenantId, x._count._all]));
  const l = new Map(leads.map((x) => [x.tenantId, x._count._all]));
  return tenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    plan: t.plan ? { name: t.plan.name, code: t.plan.code } : null,
    /** What the plan allows (null: no limit). */
    limits: parsePlanLimits(t.plan?.limits),
    createdAt: t.createdAt,
    users: u.get(t.id) ?? 0,
    leads: l.get(t.id) ?? 0,
  }));
}

export async function platformMetrics(p: Principal) {
  requireSuperAdmin(p);
  const db = ownerDb();
  const [tenants, activeTenants, users, leads, webLeads30d] = [
    await db.tenant.count(),
    await db.tenant.count({ where: { status: 'ACTIVE' } }),
    await db.user.count({ where: { deletedAt: null, tenantId: { not: null } } }),
    await db.lead.count({ where: { deletedAt: null } }),
    await db.webLead.count({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } }),
  ];
  return { tenants, activeTenants, users, leads, webLeads30d };
}

export async function createTenant(
  p: Principal,
  dto: z.output<typeof tenantCreateSchema>,
  meta: { ip?: string; userAgent?: string } = {},
) {
  requireSuperAdmin(p);
  const db = ownerDb();
  if (await db.tenant.findUnique({ where: { slug: dto.slug } }))
    throw conflict('That workspace name is taken.', { fields: { slug: 'Already taken.' } });
  const plan = await db.plan.findUnique({ where: { code: dto.planCode } });
  const result = await db.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        status: 'TRIAL',
        planId: plan?.id ?? null,
        settings: { timezone: 'Asia/Kolkata', roundRobin: false } as Prisma.InputJsonValue,
      },
    });
    await tx.leadSource.createMany({
      data: SOURCES.map(([code, label]) => ({ tenantId: tenant.id, code, label })),
    });
    const admin = await tx.user.create({
      data: {
        tenantId: tenant.id,
        roleCode: 'TENANT_ADMIN',
        name: dto.adminName,
        email: dto.adminEmail,
        passwordHash: await hashPassword(randomToken()),
      },
    });
    // Every new workspace starts with the starter automation rules (all on; the admin can change them).
    await tx.automationRule.createMany({
      data: starterRuleRows(tenant.id, null) as Prisma.AutomationRuleCreateManyInput[],
    });
    return { tenant, admin };
  });
  await auditAuth({
    tenantId: null,
    userId: p.userId,
    action: 'platform.tenant_create',
    entityType: 'tenant',
    entityId: result.tenant.id,
    newValue: { slug: dto.slug, plan: dto.planCode },
    ...meta,
  });
  const token = await issueSetPasswordToken(result.admin.id);
  const link = `${getConfig().APP_URL}/reset-password/${encodeURIComponent(token)}`;
  const mail = await sendMail(
    dto.adminEmail,
    'Your aVn CMS workspace is ready',
    `Hi ${dto.adminName},\n\nYour aVn CMS workspace "${dto.slug}" is ready. Choose your password here (works once, expires in 72 hours):\n${link}\n\nSign in with workspace "${dto.slug}".`,
  );
  return {
    id: result.tenant.id,
    slug: dto.slug,
    invite: mail.sent ? { emailed: true } : { emailed: false, link },
  };
}

export async function setTenantStatus(
  p: Principal,
  tenantId: string,
  status: TenantStatus,
  meta: { ip?: string; userAgent?: string } = {},
) {
  requireSuperAdmin(p);
  const db = ownerDb();
  const t = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!t) throw notFound('Tenant');
  await db.tenant.update({ where: { id: tenantId }, data: { status } });
  await auditAuth({
    tenantId: null,
    userId: p.userId,
    action: 'platform.tenant_status',
    entityType: 'tenant',
    entityId: tenantId,
    newValue: { from: t.status, to: status },
    ...meta,
  });
  return { id: tenantId, status };
}

/**
 * Moves an agency to another plan. Refused when the agency already has more users, leads or stored
 * documents than the new plan allows: a downgrade must never leave a workspace over its limit.
 */
export async function setTenantPlan(
  p: Principal,
  tenantId: string,
  planCode: z.output<typeof tenantPlanSchema>['planCode'],
  meta: { ip?: string; userAgent?: string } = {},
) {
  requireSuperAdmin(p);
  const db = ownerDb();
  const t = await db.tenant.findUnique({
    where: { id: tenantId },
    include: { plan: { select: { code: true } } },
  });
  if (!t) throw notFound('Tenant');
  const plan = await db.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw notFound('Plan');
  const limits = parsePlanLimits(plan.limits);
  const [users, leads, files] = await Promise.all([
    db.user.count({ where: { tenantId, deletedAt: null, status: 'ACTIVE' } }),
    db.lead.count({ where: { tenantId, deletedAt: null } }),
    db.document.aggregate({
      where: { tenantId, deletedAt: null, purgedAt: null },
      _sum: { sizeBytes: true },
    }),
  ]);
  const stored = Number(files._sum.sizeBytes ?? 0);
  const over: string[] = [];
  if (limits.users !== null && users > limits.users)
    over.push(`${users} active users (the plan allows ${limits.users})`);
  if (limits.leads !== null && leads > limits.leads)
    over.push(
      `${leads.toLocaleString('en-IN')} leads (the plan allows ${limits.leads.toLocaleString('en-IN')})`,
    );
  if (limits.storageBytes !== null && stored > limits.storageBytes)
    over.push(
      `${Math.ceil(stored / 1024 ** 2)} MB of documents (the plan allows ${Math.round(limits.storageBytes / 1024 ** 2)} MB)`,
    );
  if (over.length > 0)
    throw conflict(`${t.name} can't move to ${plan.name}: it has ${over.join(', and ')}.`, { over });
  await db.$transaction([
    db.tenant.update({ where: { id: tenantId }, data: { planId: plan.id } }),
    db.subscription.updateMany({ where: { tenantId, status: 'ACTIVE' }, data: { planId: plan.id } }),
  ]);
  await auditAuth({
    tenantId: null,
    userId: p.userId,
    action: 'platform.tenant_plan',
    entityType: 'tenant',
    entityId: tenantId,
    newValue: { from: t.plan?.code ?? null, to: planCode },
    ...meta,
  });
  return { id: tenantId, plan: { code: plan.code, name: plan.name } };
}

/**
 * Audited impersonation (RBAC rule 6): sets the session's acting tenant, writes an audit row in
 * the platform log and in the tenant's own log, and the app shows an "acting as" banner.
 */
export async function startImpersonation(
  p: Principal,
  tenantId: string,
  meta: { ip?: string; userAgent?: string } = {},
) {
  requireSuperAdmin(p);
  const t = await ownerDb().tenant.findUnique({ where: { id: tenantId } });
  if (!t) throw notFound('Tenant');
  await setActingTenant(p.sessionId, tenantId);
  await auditAuth({
    tenantId: null,
    userId: p.userId,
    action: 'platform.impersonation_start',
    entityType: 'tenant',
    entityId: tenantId,
    ...meta,
  });
  await auditAuth({
    tenantId,
    userId: p.userId,
    action: 'impersonation.start',
    entityType: 'tenant',
    entityId: tenantId,
    impersonatedBy: p.userId,
    ...meta,
  });
  return { tenantId };
}

export async function stopImpersonation(p: Principal, meta: { ip?: string; userAgent?: string } = {}) {
  requireSuperAdmin(p);
  const acting = p.actingTenantId;
  await setActingTenant(p.sessionId, null);
  if (acting) {
    await auditAuth({
      tenantId: acting,
      userId: p.userId,
      action: 'impersonation.stop',
      entityType: 'tenant',
      entityId: acting,
      impersonatedBy: p.userId,
      ...meta,
    });
    await auditAuth({
      tenantId: null,
      userId: p.userId,
      action: 'platform.impersonation_stop',
      entityType: 'tenant',
      entityId: acting,
      ...meta,
    });
  }
  return { stopped: Boolean(acting) };
}

export async function platformAudit(p: Principal, limit = 100) {
  requireSuperAdmin(p);
  return ownerDb().auditLog.findMany({
    where: { tenantId: null },
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, limit),
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      newValue: true,
      ip: true,
      createdAt: true,
    },
  });
}
