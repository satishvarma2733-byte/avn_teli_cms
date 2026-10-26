import { randomUUID } from 'node:crypto';

import {
  withTenant,
  type Document,
  type Folder,
  type Prisma,
  type StudentDocStatus,
  type StudentDocType,
  type TenantDb,
} from '@avn-cms/db';

import { recordActivity } from '../activities/activity.repository';
import { userNames } from '../assignments/assignment.repository';
import { enqueue } from '../jobs/queue';
import { listScope } from '../policy/index';
import {
  CHECKLIST_TYPES,
  DOC_TYPE_LABEL,
  MAX_DOCUMENT_BYTES,
  type ChecklistReviewDTO,
  type DocumentInitDTO,
  type FolderCreateDTO,
} from '../schemas';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, forbidden, invalid, notFound } from '../shared/errors';
import { assertRoom } from '../usage/usage.service';
import { adminOnly, manageScope, type Scope } from './access';
import { getObjectStore } from './object-store';
import { formatFor, resolveFormat, safeFilename } from './rules';

/**
 * The documents vault (Phase 7): folders for the agency's own files, and per-student documents
 * with a checklist. Files live in object storage (R2); the browser uploads and downloads through
 * short-lived presigned URLs. A file is downloadable only once a scan says it is clean, and every
 * download is audited. Folders and the vault root are admin-only; a counselor reaches only the
 * documents of students on their own leads (404 for anyone else's).
 */
const UPLOAD_URL_SECONDS = 10 * 60;
const DOWNLOAD_URL_SECONDS = 5 * 60;
const MAX_FOLDER_DEPTH = 8;
const LIST_LIMIT = 500;
const ACCEPTED = 'This file type isn’t accepted. Use PDF, JPG, PNG, WebP, Word, Excel or text files.';

/** Admins: any student. Counselors: students with a lead assigned to them; anyone else's is a 404. */
async function assertStudentAccess(db: TenantDb, ctx: Ctx, scope: Scope, studentId: string) {
  const student = await db.student.findFirst({
    where: { id: studentId, deletedAt: null },
    select: { id: true },
  });
  if (!student) throw notFound('Student');
  if (scope === 'tenant') return;
  const lead = await db.lead.findFirst({
    where: {
      studentId,
      deletedAt: null,
      assignments: { some: { assigneeId: ctx.userId, isActive: true } },
    },
    select: { id: true },
  });
  if (!lead) throw notFound('Student');
}

async function accessDocument(db: TenantDb, ctx: Ctx, scope: Scope, doc: Pick<Document, 'studentId'>) {
  if (doc.studentId) return assertStudentAccess(db, ctx, scope, doc.studentId);
  if (scope !== 'tenant') throw notFound('Document');
}

// ── Views ────────────────────────────────────────────────────────────────────

export type DocumentState = 'uploading' | 'checking' | 'ready' | 'blocked' | 'rejected';

export function stateOf(d: Pick<Document, 'uploadedAt' | 'scanStatus'>): DocumentState {
  if (!d.uploadedAt) return 'uploading';
  switch (d.scanStatus) {
    case 'CLEAN':
      return 'ready';
    case 'INFECTED':
      return 'blocked';
    case 'REJECTED':
      return 'rejected';
    default:
      return 'checking';
  }
}

function toView(d: Document, names: Map<string, string>) {
  const state = stateOf(d);
  return {
    id: d.id,
    seriesId: d.seriesId,
    folderId: d.folderId,
    studentId: d.studentId,
    docType: d.docType,
    filename: d.filename,
    mimeType: d.mimeType,
    sizeBytes: Number(d.sizeBytes),
    version: d.version,
    state,
    /** Only a clean file can be downloaded. */
    available: state === 'ready',
    problem:
      state === 'blocked'
        ? 'This file failed the safety scan and was removed.'
        : state === 'rejected'
          ? (d.scanError ?? 'This file was refused.')
          : null,
    uploadedAt: d.uploadedAt,
    createdAt: d.createdAt,
    uploadedBy: d.uploadedById ? (names.get(d.uploadedById) ?? null) : null,
  };
}
export type DocumentView = ReturnType<typeof toView>;

const folderView = (f: Folder, counts?: { folders: number; documents: number }) => ({
  id: f.id,
  name: f.name,
  parentId: f.parentId,
  createdAt: f.createdAt,
  folderCount: counts?.folders ?? 0,
  documentCount: counts?.documents ?? 0,
});
export type FolderView = ReturnType<typeof folderView>;

/** Newest version of each document series, keeping how many versions there are. */
function latestPerSeries(rows: Document[]): { latest: Document; versions: number }[] {
  const bySeries = new Map<string, { latest: Document; versions: number }>();
  for (const row of rows) {
    const seen = bySeries.get(row.seriesId);
    if (!seen) bySeries.set(row.seriesId, { latest: row, versions: 1 });
    else {
      seen.versions += 1;
      if (row.version > seen.latest.version) seen.latest = row;
    }
  }
  return [...bySeries.values()];
}

// ── Folders ──────────────────────────────────────────────────────────────────

const tidy = (name: string) => name.replace(/\s+/g, ' ').trim();

/** The folder and its parents, outermost first. 404 if the folder is missing or deleted. */
async function ancestry(db: TenantDb, folderId: string) {
  const chain: { id: string; name: string; parentId: string | null }[] = [];
  let current: string | null = folderId;
  for (let i = 0; current && i <= MAX_FOLDER_DEPTH + 1; i++) {
    const folder: { id: string; name: string; parentId: string | null } | null = await db.folder.findFirst({
      where: { id: current, deletedAt: null },
      select: { id: true, name: true, parentId: true },
    });
    if (!folder) {
      if (i === 0) throw notFound('Folder');
      break;
    }
    chain.unshift(folder);
    current = folder.parentId;
  }
  return chain;
}

async function assertNameFree(db: TenantDb, parentId: string | null, name: string, exceptId?: string) {
  const clash = await db.folder.findFirst({
    where: {
      parentId,
      deletedAt: null,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    throw conflict('A folder with that name already exists here.', {
      fields: { name: 'A folder with that name already exists here.' },
    });
  }
}

export async function listFolders(ctx: Ctx, parentId?: string) {
  adminOnly(ctx);
  return withTenant(ctx.tenantId, async (db) => {
    const trail = parentId ? await ancestry(db, parentId) : [];
    const folders = await db.folder.findMany({
      where: { parentId: parentId ?? null, deletedAt: null },
      orderBy: { name: 'asc' },
      take: LIST_LIMIT,
    });
    const ids = folders.map((f) => f.id);
    const children = ids.length
      ? await db.folder.findMany({
          where: { parentId: { in: ids }, deletedAt: null },
          select: { parentId: true },
        })
      : [];
    const files = ids.length
      ? await db.document.findMany({
          where: { folderId: { in: ids }, studentId: null, deletedAt: null, uploadedAt: { not: null } },
          select: { folderId: true, seriesId: true },
        })
      : [];
    return {
      breadcrumb: trail.map((f) => ({ id: f.id, name: f.name })),
      folders: folders.map((f) =>
        folderView(f, {
          folders: children.filter((c) => c.parentId === f.id).length,
          documents: new Set(files.filter((x) => x.folderId === f.id).map((x) => x.seriesId)).size,
        }),
      ),
    };
  });
}

export async function createFolder(ctx: Ctx, dto: FolderCreateDTO) {
  adminOnly(ctx);
  const name = tidy(dto.name);
  const parentId = dto.parentId ?? null;
  return withTenant(ctx.tenantId, async (db) => {
    if (parentId) {
      const chain = await ancestry(db, parentId);
      if (chain.length >= MAX_FOLDER_DEPTH)
        throw invalid(`Folders can be nested at most ${MAX_FOLDER_DEPTH} deep.`);
    }
    await assertNameFree(db, parentId, name);
    const folder = await db.folder.create({
      data: { name, parentId, createdById: ctx.userId } as Prisma.FolderUncheckedCreateInput,
    });
    await audit(db, ctx, 'folder.created', 'folder', folder.id, undefined, { name, parentId });
    return folderView(folder);
  });
}

export async function renameFolder(ctx: Ctx, id: string, rawName: string) {
  adminOnly(ctx);
  const name = tidy(rawName);
  return withTenant(ctx.tenantId, async (db) => {
    const folder = await db.folder.findFirst({ where: { id, deletedAt: null } });
    if (!folder) throw notFound('Folder');
    await assertNameFree(db, folder.parentId, name, id);
    await db.folder.updateMany({ where: { id }, data: { name } });
    await audit(db, ctx, 'folder.renamed', 'folder', id, { name: folder.name }, { name });
    return folderView({ ...folder, name });
  });
}

/** Only an empty folder can be deleted: nothing disappears with it. */
export async function deleteFolder(ctx: Ctx, id: string) {
  adminOnly(ctx);
  return withTenant(ctx.tenantId, async (db) => {
    const folder = await db.folder.findFirst({ where: { id, deletedAt: null } });
    if (!folder) throw notFound('Folder');
    const child = await db.folder.findFirst({
      where: { parentId: id, deletedAt: null },
      select: { id: true },
    });
    const file = await db.document.findFirst({
      where: { folderId: id, deletedAt: null },
      select: { id: true },
    });
    if (child || file) throw conflict('Move or delete what is inside this folder first.');
    await db.folder.updateMany({ where: { id }, data: { deletedAt: new Date() } });
    await audit(db, ctx, 'folder.deleted', 'folder', id, { name: folder.name }, undefined);
    return { id };
  });
}

// ── Vault documents ──────────────────────────────────────────────────────────

/** Files in a folder (or matching a search across the vault); newest version of each. */
export async function listDocuments(ctx: Ctx, q: { folderId?: string | undefined; q?: string | undefined }) {
  adminOnly(ctx);
  return withTenant(ctx.tenantId, async (db) => {
    if (q.folderId) await ancestry(db, q.folderId);
    const rows = await db.document.findMany({
      where: {
        studentId: null,
        deletedAt: null,
        uploadedAt: { not: null },
        ...(q.q ? { filename: { contains: q.q, mode: 'insensitive' } } : { folderId: q.folderId ?? null }),
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    const names = await userNames(
      db,
      rows.map((r) => r.uploadedById),
    );
    return {
      documents: latestPerSeries(rows).map(({ latest, versions }) => ({
        ...toView(latest, names),
        versionCount: versions,
      })),
    };
  });
}

export async function getDocument(ctx: Ctx, id: string) {
  const scope = manageScope(ctx);
  return withTenant(ctx.tenantId, async (db) => {
    const doc = await db.document.findFirst({ where: { id, deletedAt: null } });
    if (!doc) throw notFound('Document');
    await accessDocument(db, ctx, scope, doc);
    const versions = await db.document.findMany({
      where: { seriesId: doc.seriesId, deletedAt: null, uploadedAt: { not: null } },
      orderBy: { version: 'desc' },
    });
    const names = await userNames(
      db,
      versions.map((v) => v.uploadedById),
    );
    return { document: toView(doc, names), versions: versions.map((v) => toView(v, names)) };
  });
}

// ── Upload: start → (browser PUTs to storage) → complete → scan ──────────────

/**
 * Starts an upload: validates the file, records it as pending, and returns the presigned URL the
 * browser sends the bytes to. The URL is bound to the exact type and size declared here.
 */
export async function initUpload(ctx: Ctx, dto: DocumentInitDTO) {
  const scope = manageScope(ctx);
  const store = getObjectStore();
  const format = resolveFormat(dto.filename, dto.mimeType);
  if (!format) throw invalid(ACCEPTED, { fields: { filename: ACCEPTED } });
  if (dto.sizeBytes > MAX_DOCUMENT_BYTES) throw invalid('Files can be at most 20 MB.');
  if (dto.studentId && dto.folderId) throw invalid('A document goes in a folder or on a student, not both.');
  if (dto.docType && !dto.studentId && !dto.replaces) throw invalid('A checklist item needs a student.');
  const filename = safeFilename(dto.filename);
  const id: string = randomUUID();

  const doc = await withTenant(ctx.tenantId, async (db) => {
    let seriesId = id;
    let folderId: string | null = null;
    let studentId: string | null = null;
    let docType: StudentDocType | null = null;

    const base = dto.replaces
      ? await db.document.findFirst({
          where: { id: dto.replaces, deletedAt: null, uploadedAt: { not: null } },
        })
      : null;
    if (dto.replaces && !base) throw notFound('Document');

    if (base) {
      await accessDocument(db, ctx, scope, base);
      ({ seriesId, folderId, studentId, docType } = base);
    } else if (dto.studentId) {
      await assertStudentAccess(db, ctx, scope, dto.studentId);
      studentId = dto.studentId;
      docType = dto.docType ?? 'OTHER';
      if (docType !== 'OTHER') {
        // One current file per checklist item: another upload for it is a new version.
        const row = await db.studentDocument.findFirst({ where: { studentId, docType } });
        const current = row?.documentId
          ? await db.document.findFirst({ where: { id: row.documentId, deletedAt: null } })
          : null;
        if (current) seriesId = current.seriesId;
      }
    } else {
      if (scope !== 'tenant') throw forbidden('Only admins can add files to the folder vault.');
      if (dto.folderId) await ancestry(db, dto.folderId);
      folderId = dto.folderId ?? null;
    }

    await assertRoom(db, 'storage', dto.sizeBytes);
    let version = 1;
    if (seriesId !== id) {
      const last = await db.document.findFirst({
        where: { seriesId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      version = (last?.version ?? 0) + 1;
    }

    try {
      const created = await db.document.create({
        data: {
          id,
          seriesId,
          folderId,
          studentId,
          docType,
          filename,
          mimeType: format.mime,
          sizeBytes: BigInt(dto.sizeBytes),
          storageKey: `tenants/${ctx.tenantId}/documents/${id}`,
          version,
          uploadedById: ctx.userId,
        } as Prisma.DocumentUncheckedCreateInput,
      });
      await audit(db, ctx, 'document.upload_started', 'document', id, undefined, {
        filename,
        version,
        sizeBytes: dto.sizeBytes,
        studentId,
        folderId,
      });
      return created;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw conflict('Another upload of this document is in progress. Try again in a moment.');
      }
      throw err;
    }
  });

  const url = await store.presignPut(doc.storageKey, {
    contentType: format.mime,
    contentLength: dto.sizeBytes,
    expiresInSeconds: UPLOAD_URL_SECONDS,
  });
  return {
    document: toView(doc, new Map()),
    upload: {
      url,
      method: 'PUT' as const,
      // The browser must send exactly this type; its Content-Length is the file's own size.
      headers: { 'Content-Type': format.mime },
      expiresAt: new Date(Date.now() + UPLOAD_URL_SECONDS * 1000),
    },
  };
}

/** Links a student's document to their checklist item, creating the item's row if needed. */
async function linkChecklist(
  db: TenantDb,
  studentId: string,
  docType: StudentDocType,
  fields: {
    documentId: string | null;
    status: StudentDocStatus;
    note: string | null;
    reviewedById: string | null;
  },
) {
  const row = await db.studentDocument.findFirst({ where: { studentId, docType }, select: { id: true } });
  if (row) await db.studentDocument.updateMany({ where: { id: row.id }, data: fields });
  else {
    await db.studentDocument.create({
      data: { studentId, docType, ...fields } as Prisma.StudentDocumentUncheckedCreateInput,
    });
  }
}

/**
 * The browser says it has uploaded the file. Check it really arrived at the size declared, then
 * hand it to the scan. It is not downloadable until the scan says clean.
 */
export async function completeUpload(ctx: Ctx, id: string) {
  const scope = manageScope(ctx);
  const store = getObjectStore();
  const doc = await withTenant(ctx.tenantId, async (db) => {
    const found = await db.document.findFirst({ where: { id, deletedAt: null } });
    if (!found) throw notFound('Document');
    await accessDocument(db, ctx, scope, found);
    // Only the person who started the upload (or an admin) can finish it.
    if (found.uploadedById !== ctx.userId && scope !== 'tenant') throw notFound('Document');
    return found;
  });
  if (doc.uploadedAt) return toView(doc, new Map()); // already confirmed (a repeated click)

  const stored = await store.head(doc.storageKey);
  if (!stored) throw conflict('The file did not arrive. Upload it again.');
  if (stored.size !== Number(doc.sizeBytes) || stored.size > MAX_DOCUMENT_BYTES) {
    await store.remove(doc.storageKey);
    const message = 'The uploaded file was not the size that was declared, so it was refused.';
    await withTenant(ctx.tenantId, async (db) => {
      await db.document.updateMany({
        where: { id, uploadedAt: null },
        data: { uploadedAt: new Date(), scanStatus: 'REJECTED', scanError: message, purgedAt: new Date() },
      });
      await audit(db, ctx, 'document.rejected', 'document', id, undefined, { reason: 'size mismatch' });
    });
    throw invalid(message);
  }

  const done = await withTenant(ctx.tenantId, async (db) => {
    const res = await db.document.updateMany({
      where: { id, uploadedAt: null },
      data: { uploadedAt: new Date() },
    });
    const fresh = await db.document.findFirstOrThrow({ where: { id } });
    if (res.count !== 1) return fresh; // someone else confirmed it first
    if (doc.studentId && doc.docType && doc.docType !== 'OTHER') {
      await linkChecklist(db, doc.studentId, doc.docType, {
        documentId: id,
        status: 'UPLOADED',
        note: null,
        reviewedById: null,
      });
    }
    await audit(db, ctx, 'document.uploaded', 'document', id, undefined, {
      filename: doc.filename,
      version: doc.version,
      sizeBytes: Number(doc.sizeBytes),
      studentId: doc.studentId,
      folderId: doc.folderId,
    });
    if (doc.studentId) {
      const label = doc.docType ? DOC_TYPE_LABEL[doc.docType] : 'Document';
      await recordActivity(db, {
        studentId: doc.studentId,
        type: 'DOCUMENT',
        actorId: ctx.userId,
        summary: `${label} uploaded${doc.version > 1 ? ` (version ${doc.version})` : ''}: ${doc.filename}`,
        payload: { documentId: id, version: doc.version },
      });
    }
    return fresh;
  });

  try {
    await enqueue('document.scan', { tenantId: ctx.tenantId, jobId: id });
  } catch (err) {
    // Not fatal: the file stays "being checked" and the worker's sweep queues the scan again.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'document scan could not be queued',
        documentId: id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return toView(done, new Map());
}

// ── Download ─────────────────────────────────────────────────────────────────

/**
 * A short-lived signed URL for a clean file. The audit row is written in the same transaction as
 * the access check, so there is no download without a record.
 */
export async function documentUrl(ctx: Ctx, id: string, disposition: 'attachment' | 'inline') {
  const scope = manageScope(ctx);
  const store = getObjectStore();
  const { doc, inline } = await withTenant(ctx.tenantId, async (db) => {
    const found = await db.document.findFirst({ where: { id, deletedAt: null } });
    if (!found || !found.uploadedAt) throw notFound('Document');
    await accessDocument(db, ctx, scope, found);
    if (found.scanStatus !== 'CLEAN') {
      throw conflict(
        found.scanStatus === 'PENDING'
          ? 'This file is still being checked. Try again in a moment.'
          : 'This file is blocked and cannot be downloaded.',
        { state: stateOf(found) },
      );
    }
    const asInline = disposition === 'inline' && (formatFor(found.mimeType)?.inline ?? false);
    await audit(db, ctx, 'document.downloaded', 'document', found.id, undefined, {
      filename: found.filename,
      version: found.version,
      studentId: found.studentId,
      inline: asInline,
    });
    return { doc: found, inline: asInline };
  });
  const url = await store.presignGet(doc.storageKey, {
    filename: doc.filename,
    contentType: doc.mimeType,
    inline,
    expiresInSeconds: DOWNLOAD_URL_SECONDS,
  });
  return {
    url,
    filename: doc.filename,
    expiresAt: new Date(Date.now() + DOWNLOAD_URL_SECONDS * 1000),
  };
}

/** Removes every version of a document from view. The stored files are purged by the worker later. */
export async function deleteDocument(ctx: Ctx, id: string) {
  const scope = manageScope(ctx);
  return withTenant(ctx.tenantId, async (db) => {
    const doc = await db.document.findFirst({ where: { id, deletedAt: null } });
    if (!doc) throw notFound('Document');
    await accessDocument(db, ctx, scope, doc);
    const res = await db.document.updateMany({
      where: { seriesId: doc.seriesId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (doc.studentId && doc.docType && doc.docType !== 'OTHER') {
      await linkChecklist(db, doc.studentId, doc.docType, {
        documentId: null,
        status: 'MISSING',
        note: null,
        reviewedById: null,
      });
    }
    await audit(db, ctx, 'document.deleted', 'document', doc.id, {
      filename: doc.filename,
      versions: res.count,
    });
    if (doc.studentId) {
      await recordActivity(db, {
        studentId: doc.studentId,
        type: 'DOCUMENT',
        actorId: ctx.userId,
        summary: `${doc.docType ? DOC_TYPE_LABEL[doc.docType] : 'Document'} removed: ${doc.filename}`,
        payload: { documentId: doc.id },
      });
    }
    return { id: doc.id, versions: res.count };
  });
}

// ── Student checklist ────────────────────────────────────────────────────────

export async function getChecklist(ctx: Ctx, studentId: string) {
  const scope = manageScope(ctx);
  return withTenant(ctx.tenantId, async (db) => {
    await assertStudentAccess(db, ctx, scope, studentId);
    const rows = await db.studentDocument.findMany({ where: { studentId } });
    const docs = await db.document.findMany({
      where: { studentId, deletedAt: null },
      orderBy: { version: 'desc' },
    });
    const names = await userNames(db, [
      ...rows.map((r) => r.reviewedById),
      ...docs.map((d) => d.uploadedById),
    ]);
    const items = CHECKLIST_TYPES.map((docType) => {
      const row = rows.find((r) => r.docType === docType);
      const current = row?.documentId ? docs.find((d) => d.id === row.documentId) : undefined;
      return {
        docType,
        label: DOC_TYPE_LABEL[docType],
        status: (row?.status ?? 'MISSING') as StudentDocStatus,
        note: row?.note ?? null,
        reviewedBy: row?.reviewedById ? (names.get(row.reviewedById) ?? null) : null,
        updatedAt: row?.updatedAt ?? null,
        document: current ? toView(current, names) : null,
        versionCount: current
          ? docs.filter((d) => d.seriesId === current.seriesId && d.uploadedAt).length
          : 0,
      };
    });
    const others = latestPerSeries(docs.filter((d) => d.docType === 'OTHER' && d.uploadedAt)).map(
      ({ latest, versions }) => ({ ...toView(latest, names), versionCount: versions }),
    );
    return { studentId, items, others };
  });
}

/** Verify or reject the file on a checklist item (or put it back to "uploaded"). */
export async function reviewChecklistItem(
  ctx: Ctx,
  studentId: string,
  docType: StudentDocType,
  dto: ChecklistReviewDTO,
) {
  const scope = listScope(ctx, 'studentDoc:verify');
  if (!scope) throw forbidden();
  if (!CHECKLIST_TYPES.includes(docType)) throw invalid('That item is not on the checklist.');
  if (dto.status === 'REJECTED' && !dto.note) {
    throw invalid('Say why the file is rejected.', { fields: { note: 'Say why the file is rejected.' } });
  }
  return withTenant(ctx.tenantId, async (db) => {
    await assertStudentAccess(db, ctx, scope, studentId);
    const row = await db.studentDocument.findFirst({ where: { studentId, docType } });
    const doc = row?.documentId
      ? await db.document.findFirst({ where: { id: row.documentId, deletedAt: null } })
      : null;
    if (!row || !doc) throw conflict('Nothing has been uploaded for this item yet.');
    if (dto.status === 'VERIFIED' && doc.scanStatus !== 'CLEAN') {
      throw conflict('The file must pass the safety check before it can be verified.');
    }
    await db.studentDocument.updateMany({
      where: { id: row.id },
      data: { status: dto.status, note: dto.note ?? null, reviewedById: ctx.userId },
    });
    await audit(
      db,
      ctx,
      'document.reviewed',
      'student_document',
      row.id,
      { status: row.status },
      {
        status: dto.status,
        docType,
        studentId,
        note: dto.note ?? null,
      },
    );
    const verb =
      dto.status === 'VERIFIED'
        ? 'verified'
        : dto.status === 'REJECTED'
          ? 'rejected'
          : 'set back to uploaded';
    await recordActivity(db, {
      studentId,
      type: 'DOCUMENT',
      actorId: ctx.userId,
      summary: `${DOC_TYPE_LABEL[docType]} ${verb}${dto.note ? `: ${dto.note}` : ''}`,
      payload: { documentId: doc.id, status: dto.status },
    });
    return { docType, status: dto.status, note: dto.note ?? null };
  });
}
