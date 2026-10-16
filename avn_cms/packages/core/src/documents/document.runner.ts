import { withTenant, type Prisma, type TenantDb } from '@avn-cms/db';

import { recordActivity } from '../activities/activity.repository';
import { enqueue, type JobPayload } from '../jobs/queue';
import { DOC_TYPE_LABEL, MAX_DOCUMENT_BYTES } from '../schemas';
import { AppError } from '../shared/errors';
import { getObjectStore, objectStoreConfigured } from './object-store';
import { matchesSignature } from './rules';
import { getScanner, ScannerUnavailableError } from './scanner';

/**
 * The scan job and the worker's housekeeping for the documents vault.
 *
 * A file is released (CLEAN) only after three checks pass: it is the size that was declared, its
 * first bytes match its type, and the antivirus found nothing. Anything else keeps it from ever
 * being downloaded. If the scanner cannot be reached the file simply stays pending and the sweep
 * tries again; it is never released unscanned.
 */
export const MAX_SCAN_ATTEMPTS = 5;
const RETRY_AFTER_MS = 2 * 60_000;
/** Deleted documents stay in storage this long, then the worker removes the files. */
export const DELETED_RETENTION_DAYS = 30;
/** An upload that never reached "complete" within this long is dropped. */
const ABANDONED_AFTER_MS = 24 * 60 * 60_000;
const BATCH = 200;

const clip = (text: string) => text.slice(0, 300);

/** Audit rows written by the worker have no signed-in user. */
function systemAudit(db: TenantDb, action: string, documentId: string, value: unknown) {
  return db.auditLog.create({
    data: {
      action,
      entityType: 'document',
      entityId: documentId,
      newValue: JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue,
    } as Prisma.AuditLogUncheckedCreateInput,
  });
}

type Blocked = { status: 'INFECTED'; signature: string } | { status: 'REJECTED'; reason: string };

/** Records the decision that keeps a file from ever being served, and removes the stored copy. */
async function block(tenantId: string, docId: string, verdict: Blocked): Promise<void> {
  const reason = verdict.status === 'INFECTED' ? 'failed the safety scan' : verdict.reason;
  const changed = await withTenant(tenantId, async (db) => {
    const doc = await db.document.findFirst({ where: { id: docId, scanStatus: 'PENDING' } });
    if (!doc) return null;
    await db.document.updateMany({
      where: { id: docId, scanStatus: 'PENDING' },
      data: {
        scanStatus: verdict.status,
        scannedAt: new Date(),
        scanError: verdict.status === 'REJECTED' ? verdict.reason : null,
        scanSignature: verdict.status === 'INFECTED' ? clip(verdict.signature) : null,
      },
    });
    if (doc.studentId && doc.docType && doc.docType !== 'OTHER') {
      await db.studentDocument.updateMany({
        where: { documentId: docId },
        data: {
          status: 'REJECTED',
          note: 'Upload a new copy.',
          reviewedById: null,
        },
      });
    }
    await systemAudit(db, 'document.scanned', docId, {
      status: verdict.status,
      ...(verdict.status === 'INFECTED' ? { signature: verdict.signature } : { reason: verdict.reason }),
    });
    if (doc.studentId) {
      await recordActivity(db, {
        studentId: doc.studentId,
        type: 'DOCUMENT',
        summary: `${doc.docType ? DOC_TYPE_LABEL[doc.docType] : 'Document'} blocked (${reason}): ${doc.filename}`,
        payload: { documentId: docId, status: verdict.status },
      });
    }
    return doc;
  });
  if (!changed) return;
  // The stored copy goes now, so even a leaked link has nothing to fetch.
  try {
    await getObjectStore().remove(changed.storageKey);
    await withTenant(tenantId, (db) =>
      db.document.updateMany({ where: { id: docId }, data: { purgedAt: new Date() } }),
    );
  } catch {
    // The maintenance sweep removes it later (purgedAt is still empty).
  }
}

/** The job: vet one uploaded file and either release it or keep it blocked. */
export async function scanDocument({ tenantId, jobId }: JobPayload): Promise<void> {
  const claimed = await withTenant(tenantId, async (db) => {
    const doc = await db.document.findFirst({
      where: { id: jobId, deletedAt: null, uploadedAt: { not: null }, scanStatus: 'PENDING' },
    });
    if (!doc) return null; // gone, not uploaded yet, or already decided
    await db.document.updateMany({
      where: { id: jobId },
      data: { scanAttempts: { increment: 1 }, scannedAt: new Date() },
    });
    return doc;
  });
  if (!claimed) return;

  try {
    const store = getObjectStore();
    const scanner = getScanner();
    if (!scanner) {
      throw new ScannerUnavailableError('No antivirus is configured, so this file cannot be released.');
    }
    const stored = await store.head(claimed.storageKey);
    if (!stored) {
      return await block(tenantId, jobId, { status: 'REJECTED', reason: 'The uploaded file is missing.' });
    }
    if (stored.size !== Number(claimed.sizeBytes) || stored.size > MAX_DOCUMENT_BYTES) {
      return await block(tenantId, jobId, {
        status: 'REJECTED',
        reason: 'The uploaded file was not the size that was declared.',
      });
    }
    const start = await store.readStart(claimed.storageKey, 4096);
    if (!matchesSignature(claimed.mimeType, start)) {
      return await block(tenantId, jobId, {
        status: 'REJECTED',
        reason: 'The file’s contents do not match its type, so it was refused.',
      });
    }

    const verdict = await scanner.scan(await store.stream(claimed.storageKey));
    if (verdict.status === 'INFECTED') return await block(tenantId, jobId, verdict);

    await withTenant(tenantId, async (db) => {
      const res = await db.document.updateMany({
        where: { id: jobId, scanStatus: 'PENDING' },
        data: { scanStatus: 'CLEAN', scannedAt: new Date(), scanError: null },
      });
      if (res.count === 1) await systemAudit(db, 'document.scanned', jobId, { status: 'CLEAN' });
    });
  } catch (err) {
    // Could not reach storage or the scanner: leave it pending (never released) and say why.
    const message =
      err instanceof ScannerUnavailableError || err instanceof AppError
        ? err.message
        : 'The file could not be checked.';
    if (!(err instanceof ScannerUnavailableError || err instanceof AppError)) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'document scan failed',
          documentId: jobId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    await withTenant(tenantId, (db) =>
      db.document.updateMany({
        where: { id: jobId, scanStatus: 'PENDING' },
        data: { scanError: clip(message), scannedAt: new Date() },
      }),
    );
  }
}

export interface MaintenanceResult {
  requeued: number;
  purged: number;
  abandoned: number;
}

/**
 * Worker housekeeping for one workspace: queue scans that never ran or failed, remove the stored
 * files of blocked and long-deleted documents, and drop uploads that were never completed.
 */
export async function maintainDocuments(tenantId: string, now = new Date()): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { requeued: 0, purged: 0, abandoned: 0 };

  const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS);
  const due = await withTenant(tenantId, (db) =>
    db.document.findMany({
      where: {
        scanStatus: 'PENDING',
        deletedAt: null,
        uploadedAt: { not: null, lt: retryBefore },
        scanAttempts: { lt: MAX_SCAN_ATTEMPTS },
        OR: [{ scannedAt: null }, { scannedAt: { lt: retryBefore } }],
      },
      select: { id: true },
      take: BATCH,
    }),
  );
  for (const { id } of due) {
    try {
      await enqueue('document.scan', { tenantId, jobId: id });
      result.requeued += 1;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'document scan could not be queued',
          documentId: id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  if (!objectStoreConfigured()) return result;
  const store = getObjectStore();

  const keepUntil = new Date(now.getTime() - DELETED_RETENTION_DAYS * 86_400_000);
  const purgeable = await withTenant(tenantId, (db) =>
    db.document.findMany({
      where: {
        purgedAt: null,
        OR: [{ scanStatus: { in: ['INFECTED', 'REJECTED'] } }, { deletedAt: { lt: keepUntil } }],
      },
      select: { id: true, storageKey: true },
      take: BATCH,
    }),
  );
  for (const doc of purgeable) {
    try {
      await store.remove(doc.storageKey);
      await withTenant(tenantId, (db) =>
        db.document.updateMany({ where: { id: doc.id }, data: { purgedAt: now } }),
      );
      result.purged += 1;
    } catch {
      // Storage is down; try again next time.
    }
  }

  const stale = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const abandoned = await withTenant(tenantId, (db) =>
    db.document.findMany({
      where: { uploadedAt: null, deletedAt: null, createdAt: { lt: stale } },
      select: { id: true, storageKey: true },
      take: BATCH,
    }),
  );
  for (const doc of abandoned) {
    try {
      await store.remove(doc.storageKey);
      await withTenant(tenantId, (db) =>
        db.document.updateMany({ where: { id: doc.id }, data: { deletedAt: now, purgedAt: now } }),
      );
      result.abandoned += 1;
    } catch {
      // Storage is down; try again next time.
    }
  }
  return result;
}
