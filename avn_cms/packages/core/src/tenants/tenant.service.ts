import { withTenant, type Prisma } from '@avn-cms/db';
import { z } from 'zod';

import { authorize } from '../policy/index';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, notFound } from '../shared/errors';
import { tenantTimezone } from '../shared/time';

export const settingsUpdateSchema = z
  .object({
    timezone: z
      .string()
      .max(60)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown time zone.')
      .optional(),
    roundRobin: z.boolean().optional(),
    uncontactedMinutes: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update.' });

export const sourceCreateSchema = z.object({
  label: z.string().trim().min(1, 'Name the source.').max(60),
});
export const sourceUpdateSchema = z
  .object({ label: z.string().trim().min(1).max(60).optional(), isActive: z.boolean().optional() })
  .refine((v) => v.label !== undefined || v.isActive !== undefined, { message: 'Nothing to update.' });

export async function getSettings(ctx: Ctx) {
  authorize(ctx, 'settings:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const t = await db.tenant.findFirst({
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        settings: true,
        plan: { select: { name: true, code: true } },
      },
    });
    if (!t) throw notFound('Workspace');
    const s = (t.settings ?? {}) as Record<string, unknown>;
    const sources = await db.leadSource.findMany({
      orderBy: { label: 'asc' },
      select: { id: true, code: true, label: true, isActive: true },
    });
    return {
      name: t.name,
      slug: t.slug,
      status: t.status,
      plan: t.plan,
      timezone: tenantTimezone(s),
      roundRobin: s['roundRobin'] === true,
      uncontactedMinutes: typeof s['uncontactedMinutes'] === 'number' ? s['uncontactedMinutes'] : 30,
      sources,
    };
  });
}

export async function updateSettings(ctx: Ctx, dto: z.output<typeof settingsUpdateSchema>) {
  authorize(ctx, 'settings:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const t = await db.tenant.findFirst({ select: { id: true, settings: true } });
    if (!t) throw notFound('Workspace');
    const before = (t.settings ?? {}) as Record<string, unknown>;
    const after = {
      ...before,
      ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)),
    };
    await db.tenant.updateMany({ where: { id: t.id }, data: { settings: after as Prisma.InputJsonValue } });
    await audit(db, ctx, 'settings.update', 'tenant', t.id, before, after);
    return after;
  });
}

function codeFor(label: string): string {
  return (
    label
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || 'SOURCE'
  );
}

export async function createSource(ctx: Ctx, dto: z.output<typeof sourceCreateSchema>) {
  authorize(ctx, 'settings:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const code = codeFor(dto.label);
    if (await db.leadSource.findFirst({ where: { code } }))
      throw conflict('A source with this name already exists.', { fields: { label: 'Already exists.' } });
    const s = await db.leadSource.create({
      data: { code, label: dto.label } as Prisma.LeadSourceUncheckedCreateInput,
    });
    await audit(db, ctx, 'source.create', 'lead_source', s.id, undefined, { code, label: dto.label });
    return s;
  });
}

export async function updateSource(ctx: Ctx, id: string, dto: z.output<typeof sourceUpdateSchema>) {
  authorize(ctx, 'settings:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const s = await db.leadSource.findFirst({ where: { id } });
    if (!s) throw notFound('Source');
    await db.leadSource.updateMany({ where: { id }, data: dto });
    await audit(db, ctx, 'source.update', 'lead_source', id, { label: s.label, isActive: s.isActive }, dto);
    return { id };
  });
}
