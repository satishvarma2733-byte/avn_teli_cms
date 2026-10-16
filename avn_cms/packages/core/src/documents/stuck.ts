import { withTenant } from '@avn-cms/db';

import { userNames } from '../assignments/assignment.repository';
import { enqueue } from '../jobs/queue';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, notFound } from '../shared/errors';
import { adminOnly } from './access';
import { MAX_SCAN_ATTEMPTS } from './document.runner';

/**
 * Files whose virus scan did not finish. They stay blocked (never released unscanned), the worker
 * retries a few times, and then gives up; this is how an admin sees them and asks for another try
 * once the cause (usually the scanner being down) is fixed.
 */
const LIST_LIMIT = 200;

export async function listStuckScans(ctx: Ctx) {
  adminOnly(ctx);
  return withTenant(ctx.tenantId, async (db) => {
    const rows = await db.document.findMany({
      where: {
        deletedAt: null,
        uploadedAt: { not: null },
        scanStatus: 'PENDING',
        OR: [{ scanAttempts: { gte: MAX_SCAN_ATTEMPTS } }, { scanError: { not: null } }],
      },
      orderBy: { uploadedAt: 'asc' },
      take: LIST_LIMIT,
    });
    const studentIds = [...new Set(rows.flatMap((r) => (r.studentId ? [r.studentId] : [])))];
    const folderIds = [...new Set(rows.flatMap((r) => (r.folderId ? [r.folderId] : [])))];
    const students = studentIds.length
      ? await db.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true } })
      : [];
    const leads = studentIds.length
      ? await db.lead.findMany({
          where: { studentId: { in: studentIds }, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true, studentId: true },
        })
      : [];
    const folders = folderIds.length
      ? await db.folder.findMany({ where: { id: { in: folderIds } }, select: { id: true, name: true } })
      : [];
    const names = await userNames(
      db,
      rows.map((r) => r.uploadedById),
    );
    return {
      maxAttempts: MAX_SCAN_ATTEMPTS,
      stuck: rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        sizeBytes: Number(r.sizeBytes),
        version: r.version,
        attempts: r.scanAttempts,
        exhausted: r.scanAttempts >= MAX_SCAN_ATTEMPTS,
        error: r.scanError,
        lastAttemptAt: r.scannedAt,
        uploadedAt: r.uploadedAt,
        uploadedBy: r.uploadedById ? (names.get(r.uploadedById) ?? null) : null,
        student: r.studentId
          ? {
              id: r.studentId,
              name: students.find((s) => s.id === r.studentId)?.name ?? 'A student',
              leadId: leads.find((l) => l.studentId === r.studentId)?.id ?? null,
            }
          : null,
        folder: r.folderId
          ? { id: r.folderId, name: folders.find((f) => f.id === r.folderId)?.name ?? '' }
          : null,
      })),
    };
  });
}

/** Another try for a file that could not be checked: resets its attempts and queues the scan. */
export async function rescanDocument(ctx: Ctx, id: string) {
  adminOnly(ctx);
  await withTenant(ctx.tenantId, async (db) => {
    const doc = await db.document.findFirst({ where: { id, deletedAt: null } });
    if (!doc || !doc.uploadedAt) throw notFound('Document');
    if (doc.scanStatus !== 'PENDING') throw conflict('This file has already been checked.');
    await db.document.updateMany({
      where: { id, scanStatus: 'PENDING' },
      data: { scanAttempts: 0, scanError: null, scannedAt: null },
    });
    await audit(db, ctx, 'document.rescan_requested', 'document', id, undefined, {
      filename: doc.filename,
      attempts: doc.scanAttempts,
      error: doc.scanError,
    });
  });
  try {
    await enqueue('document.scan', { tenantId: ctx.tenantId, jobId: id });
  } catch (err) {
    // Not fatal: attempts are reset, so the worker's sweep queues it within a couple of minutes.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'document scan could not be queued',
        documentId: id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return { id };
}
