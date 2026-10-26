import { withTenant, type IntakeChannel, type Prisma, type WebLeadStatus } from '@avn-cms/db';
import type { z } from 'zod';

import { recordActivity } from '../activities/activity.repository';
import { emitAutomation } from '../automation/emit';
import {
  assertAssignable,
  pickRoundRobin,
  setAssignment,
  userNames,
} from '../assignments/assignment.repository';
import { authorize, can, listScope } from '../policy/index';
import { CLOSED_STAGES, type webLeadConvertSchema, type webLeadListQuerySchema } from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, forbidden, invalid, notFound } from '../shared/errors';
import { assertRoom } from '../usage/usage.service';
import { decodeKeyset, encodeKeyset, keysetWhere } from '../shared/pagination';
import { loadSettings } from '../tenants/settings';
import { sourceCodeFor, type IntakeDTO } from './intake';

/** A repeat from the same phone inside this window is the "identical repeats" junk class. */
const REPEAT_WINDOW_MS = 24 * 3_600_000;

export interface IngestResult {
  id: string;
  status: WebLeadStatus;
  /** True when an Idempotency-Key replay returned the first submission. */
  replay: boolean;
}

/**
 * Stores one external submission (all intake routes end here). Fast path only: one indexed
 * duplicate lookup + one insert. Assignment and conversion happen later (inbox / automation).
 */
export async function ingest(input: {
  tenantId: string;
  credentialId: string | null;
  defaultSourceId: string | null;
  channel: IntakeChannel;
  dto: IntakeDTO;
  rawPayload: unknown;
  idempotencyKey?: string | null;
}): Promise<IngestResult> {
  const { dto } = input;
  return withTenant(input.tenantId, async (db) => {
    if (input.idempotencyKey) {
      const prior = await db.webLead.findFirst({
        where: {
          intakeCredentialId: input.credentialId,
          idempotencyKey: input.idempotencyKey,
          createdAt: { gte: new Date(Date.now() - REPEAT_WINDOW_MS) },
        },
        select: { id: true, status: true },
      });
      if (prior) return { id: prior.id, status: prior.status, replay: true };
    }

    const code = sourceCodeFor(dto.sourceLabel, dto.utmSource, dto.gclid);
    const source =
      (input.defaultSourceId && code === 'WEBSITE'
        ? await db.leadSource.findFirst({ where: { id: input.defaultSourceId } })
        : null) ??
      (await db.leadSource.findFirst({ where: { code } })) ??
      (await db.leadSource.findFirst({ where: { code: 'WEBSITE' } }));

    const student = await db.student.findFirst({
      where: { phoneE164: dto.phoneE164, deletedAt: null },
      select: { id: true },
    });
    const recent = await db.webLead.findFirst({
      where: { phoneE164: dto.phoneE164, submittedAt: { gte: new Date(Date.now() - REPEAT_WINDOW_MS) } },
      select: { id: true },
    });
    const flags = [...dto.qualityFlags];
    if (recent) flags.push('REPEAT_SUBMISSION');
    const status: WebLeadStatus = student || recent ? 'DUPLICATE' : 'NEW';

    const row = await db.webLead.create({
      data: {
        name: dto.name,
        phoneRaw: dto.phoneRaw,
        phoneE164: dto.phoneE164,
        email: dto.email,
        interestCountry: dto.interestCountry,
        interestCourse: dto.interestCourse,
        message: dto.message,
        sourceId: source?.id ?? null,
        sourceLabel: dto.sourceLabel,
        status,
        dedupeMatchStudentId: student?.id ?? null,
        rawPayload: (input.rawPayload ?? {}) as Prisma.InputJsonValue,
        intakeChannel: input.channel,
        intakeCredentialId: input.credentialId,
        city: dto.city,
        neetScore: dto.neetScore,
        neetStatus: dto.neetStatus,
        education: dto.education,
        educationGroup: dto.educationGroup,
        submittedBy: dto.submittedBy,
        postSlug: dto.postSlug,
        gclid: dto.gclid,
        campaignId: dto.campaignId,
        pageUrl: dto.pageUrl,
        landingPage: dto.landingPage,
        utmSource: dto.utmSource,
        utmMedium: dto.utmMedium,
        utmCampaign: dto.utmCampaign,
        utmTerm: dto.utmTerm,
        utmContent: dto.utmContent,
        formId: dto.formId,
        sessionId: dto.sessionId,
        qualityFlags: flags,
        idempotencyKey: input.idempotencyKey ?? null,
      } as Prisma.WebLeadUncheckedCreateInput,
      select: { id: true, status: true },
    });
    // Rules (for example "route to a counselor") react to the new submission once it is committed.
    await emitAutomation(db, input.tenantId, {
      trigger: 'WEB_LEAD_CREATED',
      entityId: row.id,
      dedupeKey: row.id,
      payload: () => ({
        webLeadId: row.id,
        name: dto.name,
        status: row.status,
        sourceId: source?.id ?? null,
        country: dto.interestCountry ?? null,
        neetScore: dto.neetScore ?? null,
      }),
    });
    return { id: row.id, status: row.status, replay: false };
  });
}

// ── Inbox ────────────────────────────────────────────────────────────────────

const listSelect = {
  id: true,
  name: true,
  phoneE164: true,
  email: true,
  interestCountry: true,
  interestCourse: true,
  message: true,
  sourceLabel: true,
  status: true,
  submittedAt: true,
  createdAt: true,
  dedupeMatchStudentId: true,
  convertedLeadId: true,
  intakeChannel: true,
  city: true,
  neetScore: true,
  utmSource: true,
  utmCampaign: true,
  gclid: true,
  postSlug: true,
  qualityFlags: true,
  routedToId: true,
  routedAt: true,
  source: { select: { id: true, label: true } },
} satisfies Prisma.WebLeadSelect;

export async function listInbox(ctx: Ctx, q: z.output<typeof webLeadListQuerySchema>) {
  const scope = listScope(ctx, 'webLead:view');
  if (!scope) throw forbidden();
  const cursor = decodeKeyset(q.cursor, 'inbox');
  return withTenant(ctx.tenantId, async (db) => {
    const and: Prisma.WebLeadWhereInput[] = [];
    // Counselors see only the web leads routed to them (by an automation rule or an admin).
    if (scope === 'own') and.push({ routedToId: ctx.userId });
    if (q.status) and.push({ status: q.status });
    if (q.sourceId) and.push({ sourceId: q.sourceId });
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      and.push({
        OR: [
          { name: { contains: q.q, mode: 'insensitive' } },
          ...(digits.length >= 4 ? [{ phoneE164: { contains: digits } }] : []),
          { email: { contains: q.q, mode: 'insensitive' } },
        ],
      });
    }
    const rows = await db.webLead.findMany({
      where: { AND: [...and, keysetWhere('createdAt', 'desc', cursor)] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      select: listSelect,
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const grouped = await db.webLead.groupBy({
      by: ['status'],
      where: scope === 'own' ? { routedToId: ctx.userId } : {},
      _count: { _all: true },
    });
    const last = items[items.length - 1];
    const routed = await userNames(
      db,
      items.map((i) => i.routedToId),
    );
    return {
      items: items.map((i) => ({
        ...i,
        routedToName: i.routedToId ? (routed.get(i.routedToId) ?? null) : null,
      })),
      nextCursor: hasMore && last ? encodeKeyset('inbox', last.createdAt, last.id) : null,
      counts: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Record<string, number>,
    };
  });
}

export async function getWebLead(ctx: Ctx, id: string) {
  authorize(ctx, 'webLead:view');
  const own = listScope(ctx, 'webLead:view') === 'own';
  return withTenant(ctx.tenantId, async (db) => {
    const row = await db.webLead.findFirst({
      where: { id },
      include: { source: { select: { id: true, label: true } } },
    });
    // A counselor reaches only what was routed to them; anyone else's is a 404.
    if (!row || (own && row.routedToId !== ctx.userId)) throw notFound('Web lead');
    const match = row.dedupeMatchStudentId
      ? await db.student.findFirst({
          where: { id: row.dedupeMatchStudentId },
          select: {
            id: true,
            name: true,
            leads: {
              where: { deletedAt: null },
              select: { id: true, stage: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        })
      : null;
    const names = await userNames(db, [row.reviewedById]);
    return { ...row, reviewedByName: row.reviewedById ? (names.get(row.reviewedById) ?? null) : null, match };
  });
}

export async function setStatus(ctx: Ctx, id: string, status: 'DUPLICATE' | 'SPAM' | 'REJECTED' | 'NEW') {
  authorize(ctx, 'webLead:convert');
  if (ctx.role !== 'TENANT_ADMIN' && ctx.role !== 'SUPER_ADMIN') throw forbidden();
  return withTenant(ctx.tenantId, async (db) => {
    const row = await db.webLead.findFirst({ where: { id }, select: { status: true } });
    if (!row) throw notFound('Web lead');
    if (row.status === 'CONVERTED') throw conflict('A converted web lead can’t change status.');
    await db.webLead.updateMany({
      where: { id },
      data: { status, reviewedById: ctx.userId, reviewedAt: new Date() },
    });
    await audit(db, ctx, 'web_lead.status', 'web_lead', id, { status: row.status }, { status });
    return { id, status };
  });
}

/**
 * Convert to student + lead (PAGES_AND_ROUTES "review → convert"). A matching phone attaches
 * to the existing student: an open lead gets a "came back" note; a closed history gets a new
 * lead (re-inquiry). A person is never created twice (ARCHITECTURE §6).
 */
export async function convert(ctx: Ctx, id: string, dto: z.output<typeof webLeadConvertSchema>) {
  authorize(ctx, 'webLead:convert');
  if (ctx.role === 'COUNSELOR') {
    // Counselors may only take a web lead for themselves ("assign self").
    if (dto.counselorId && dto.counselorId !== ctx.userId)
      throw forbidden('You can only assign a web lead to yourself.');
    if (dto.telecallerId) throw forbidden();
  }
  return withTenant(ctx.tenantId, async (db) => {
    const wl = await db.webLead.findFirst({ where: { id } });
    // A counselor can take only a web lead routed to them.
    if (!wl || (ctx.role === 'COUNSELOR' && wl.routedToId !== ctx.userId)) throw notFound('Web lead');
    if (wl.status === 'CONVERTED')
      throw conflict('This web lead was already converted.', { leadId: wl.convertedLeadId });
    if (!wl.phoneE164) throw invalid('This submission has no usable phone number.');

    const existing = await db.student.findFirst({
      where: {
        phoneE164: wl.phoneE164,
        deletedAt: null,
        ...(dto.attachToStudentId ? { id: dto.attachToStudentId } : {}),
      },
      include: {
        leads: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true, stage: true },
        },
      },
    });
    if (dto.attachToStudentId && !existing) throw invalid('That student does not match this phone number.');

    const sourceId = wl.sourceId ?? (await db.leadSource.findFirst({ where: { code: 'WEBSITE' } }))?.id;
    if (!sourceId) throw invalid('Set up a WEBSITE lead source first.');

    let studentId: string;
    let leadId: string;
    let created = false;
    const openLead = existing?.leads.find((l) => !CLOSED_STAGES.includes(l.stage));
    if (existing && openLead) {
      studentId = existing.id;
      leadId = openLead.id;
      await recordActivity(db, {
        studentId,
        leadId,
        type: 'SYSTEM',
        actorId: ctx.userId,
        summary: `Enquired again via ${wl.sourceLabel ?? 'website'}${wl.message ? ` — “${wl.message.slice(0, 300)}”` : ''}`,
        payload: { webLeadId: wl.id },
      });
    } else {
      // A new lead counts against the plan (the enquiry itself never does, so no website enquiry is lost).
      await assertRoom(db, 'leads');
      if (existing) studentId = existing.id;
      else {
        const s = await db.student.create({
          data: {
            name: wl.name,
            phoneRaw: wl.phoneRaw,
            phoneE164: wl.phoneE164,
            email: wl.email,
            town: wl.city,
            createdById: ctx.userId,
          } as Prisma.StudentUncheckedCreateInput,
        });
        studentId = s.id;
      }
      const lead = await db.lead.create({
        data: {
          studentId,
          sourceId,
          stage: 'NEW',
          interestCountry: wl.interestCountry,
          interestCourse: wl.interestCourse ?? 'MBBS',
        } as Prisma.LeadUncheckedCreateInput,
      });
      leadId = lead.id;
      created = true;
      await db.leadStatusHistory.create({
        data: {
          leadId,
          fromStage: null,
          toStage: 'NEW',
          changedById: ctx.userId,
          note: 'Converted from web lead',
        } as Prisma.LeadStatusHistoryUncheckedCreateInput,
      });
      await recordActivity(db, {
        studentId,
        leadId,
        type: 'SYSTEM',
        actorId: ctx.userId,
        summary: `Converted from web lead (${wl.sourceLabel ?? 'website'})`,
        payload: { webLeadId: wl.id, utmCampaign: wl.utmCampaign, gclid: wl.gclid, postSlug: wl.postSlug },
      });
      if (wl.message) {
        await db.note.create({
          data: {
            leadId,
            authorId: ctx.userId,
            body: `Enquiry message: ${wl.message}`,
          } as Prisma.NoteUncheckedCreateInput,
        });
      }
    }

    // Assignment: explicit, or the counselor themself, or round-robin when enabled and none is set.
    const settings = await loadSettings(db);
    const current = await db.leadAssignment.findFirst({
      where: { leadId, roleFunction: 'COUNSELOR', isActive: true },
    });
    let counselorId = ctx.role === 'COUNSELOR' ? ctx.userId : (dto.counselorId ?? null);
    // Routed to a counselor already: they get the lead, if they are still around.
    if (!counselorId && !current && wl.routedToId) {
      const routed = await db.user.findFirst({
        where: { id: wl.routedToId, status: 'ACTIVE', deletedAt: null, roleCode: 'COUNSELOR' },
        select: { id: true },
      });
      counselorId = routed?.id ?? null;
    }
    if (!counselorId && !current && settings.roundRobin) counselorId = await pickRoundRobin(db, 'COUNSELOR');
    if (counselorId && counselorId !== current?.assigneeId) {
      await assertAssignable(db, counselorId, 'COUNSELOR');
      await setAssignment(db, leadId, 'COUNSELOR', counselorId, ctx.userId);
    }
    if (dto.telecallerId) {
      await assertAssignable(db, dto.telecallerId, 'TELECALLER');
      await setAssignment(db, leadId, 'TELECALLER', dto.telecallerId, ctx.userId);
    }

    await db.webLead.updateMany({
      where: { id: wl.id },
      data: {
        status: 'CONVERTED',
        convertedLeadId: leadId,
        dedupeMatchStudentId: existing?.id ?? null,
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
      },
    });
    await audit(
      db,
      ctx,
      'web_lead.convert',
      'web_lead',
      wl.id,
      { status: wl.status },
      { leadId, studentId, createdLead: created },
    );
    return { leadId, studentId, createdLead: created, attachedToExisting: Boolean(existing) };
  });
}

export function canViewInbox(ctx: Ctx): boolean {
  return can(ctx, 'webLead:view') && listScope(ctx, 'webLead:view') === 'tenant';
}
