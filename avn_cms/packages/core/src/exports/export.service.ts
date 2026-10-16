import { withTenant, type Prisma } from '@avn-cms/db';

import { enqueue } from '../jobs/queue';
import { authorize, listScope } from '../policy/index';
import { leadListQuerySchema, webLeadListQuerySchema, type ExportCreateDTO } from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { forbidden, invalid, notFound } from '../shared/errors';
import { signedDownloadPath } from '../storage/files';
import type { ExportParams } from './export.runner';

const EXPORT_NOT_STARTED = 'The export could not be started. Try again.';

/**
 * Background exports (Phase 6): the request only records the job; the worker writes the file.
 * Scope follows the workspace: counselors and telecallers export only their own leads, and
 * telecallers get the reduced field set. Each user sees only their own exports.
 */
export async function requestExport(ctx: Ctx, dto: ExportCreateDTO) {
  authorize(ctx, 'export:run');
  if (dto.entity === 'web_leads' && listScope(ctx, 'webLead:view') !== 'tenant')
    throw forbidden('Only admins can export web leads.');
  // Validate the filters now so a bad request fails here, not in the background.
  const filters = Object.fromEntries(
    Object.entries(dto.filters).filter(([k]) => !['cursor', 'limit', 'sort'].includes(k)),
  );
  const check = (dto.entity === 'leads' ? leadListQuerySchema : webLeadListQuerySchema).safeParse({
    ...filters,
    limit: 1,
  });
  if (!check.success) {
    throw invalid('Some export filters are not valid.', {
      fields: Object.fromEntries(check.error.issues.map((i) => [i.path.join('.'), i.message])),
    });
  }
  const params: ExportParams = {
    entity: dto.entity,
    format: dto.format,
    filters,
    requestedBy: {
      userId: ctx.userId,
      role: ctx.role,
      ...(ctx.impersonatedBy ? { impersonatedBy: ctx.impersonatedBy } : {}),
    },
  };
  const job = await withTenant(ctx.tenantId, async (db) => {
    const j = await db.exportJob.create({
      data: {
        requestedById: ctx.userId,
        type: dto.entity,
        status: 'QUEUED',
        params: params as unknown as Prisma.InputJsonValue,
      } as Prisma.ExportJobUncheckedCreateInput,
    });
    await audit(db, ctx, 'export.requested', 'export_job', j.id, undefined, {
      entity: dto.entity,
      format: dto.format,
      filters,
    });
    return j;
  });
  try {
    await enqueue('export.run', { tenantId: ctx.tenantId, jobId: job.id });
  } catch (err) {
    // The queue never took the job (Redis unreachable): no worker will claim it, and the stuck-jobs
    // sweep leaves QUEUED alone, so it would read "Preparing" for ever. Fail it, plainly, so the
    // person can ask again. Only while it is still QUEUED: a worker that did get the job keeps it.
    await withTenant(ctx.tenantId, (db) =>
      db.exportJob.updateMany({
        where: { id: job.id, status: 'QUEUED' },
        data: { status: 'FAILED', result: { error: EXPORT_NOT_STARTED }, finishedAt: new Date() },
      }),
    ).catch((undoErr: unknown) =>
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'export could not be failed after the queue refused it',
          jobId: job.id,
          error: undoErr instanceof Error ? undoErr.message : String(undoErr),
        }),
      ),
    );
    throw err;
  }
  return getExport(ctx, job.id);
}

function view(
  ctx: Ctx,
  j: {
    id: string;
    type: string;
    status: string;
    params: Prisma.JsonValue;
    result: Prisma.JsonValue;
    fileKey: string | null;
    createdAt: Date;
    finishedAt: Date | null;
  },
) {
  const p = j.params as unknown as ExportParams;
  const r = (j.result ?? {}) as { rows?: number; filename?: string; sizeBytes?: number; error?: string };
  const expired = j.finishedAt ? Date.now() - j.finishedAt.getTime() > 7 * 86_400_000 : false;
  return {
    id: j.id,
    entity: p.entity,
    format: p.format,
    status: j.status,
    rows: r.rows ?? null,
    filename: r.filename ?? null,
    sizeBytes: r.sizeBytes ?? null,
    error: r.error ?? null,
    downloadUrl:
      j.status === 'DONE' && j.fileKey && !expired ? signedDownloadPath(j.fileKey, ctx.userId) : null,
    expired,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
  };
}
export type ExportView = ReturnType<typeof view>;

export async function getExport(ctx: Ctx, id: string) {
  authorize(ctx, 'export:run');
  const j = await withTenant(ctx.tenantId, (db) =>
    db.exportJob.findFirst({ where: { id, requestedById: ctx.userId } }),
  );
  if (!j) throw notFound('Export');
  return view(ctx, j);
}

export async function listExports(ctx: Ctx) {
  authorize(ctx, 'export:run');
  const jobs = await withTenant(ctx.tenantId, (db) =>
    db.exportJob.findMany({ where: { requestedById: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  );
  return jobs.map((j) => view(ctx, j));
}
