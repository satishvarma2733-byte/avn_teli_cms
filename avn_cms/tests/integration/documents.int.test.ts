import {
  AppError,
  documents,
  getObjectStore,
  maintainDocuments,
  ScannerUnavailableError,
  setScannerForTests,
} from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

/**
 * Documents vault against the real thing: MinIO (S3 API, standing in for R2) and ClamAV from the
 * docker stack. The antivirus test string is assembled at run time so this file never contains it
 * whole (a developer's own antivirus would otherwise quarantine it).
 */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};

type Ctx = ReturnType<typeof ctxFor>;
type Target = {
  studentId?: string;
  folderId?: string | null;
  docType?: Parameters<typeof documents.initUpload>[1]['docType'];
  replaces?: string;
};

/** The whole browser flow: start, PUT the bytes to storage, confirm. */
async function upload(ctx: Ctx, filename: string, bytes: Buffer, target: Target = {}) {
  const init = await documents.initUpload(ctx, {
    filename,
    mimeType: '',
    sizeBytes: bytes.length,
    ...target,
  });
  const res = await fetch(init.upload.url, {
    method: init.upload.method,
    headers: init.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(res.status).toBe(200);
  await documents.completeUpload(ctx, init.document.id);
  return init.document.id;
}

const stateOf = async (ctx: Ctx, id: string) => (await documents.getDocument(ctx, id)).document.state;

describe('documents vault', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let c1: Awaited<ReturnType<typeof makeUser>>;
  let c2: Awaited<ReturnType<typeof makeUser>>;
  let t1: Awaited<ReturnType<typeof makeUser>>;
  let mine: Awaited<ReturnType<typeof makeLead>>;
  let theirs: Awaited<ReturnType<typeof makeLead>>;
  let adminCtx: Ctx;
  let c1Ctx: Ctx;
  let c2Ctx: Ctx;

  beforeEach(async () => {
    // Remove what the previous test left in the bucket, then the data that pointed at it.
    const store = getObjectStore();
    for (const d of await ownerDb().document.findMany({ select: { storageKey: true } })) {
      await store.remove(d.storageKey);
    }
    await resetData();
    tenant = await makeTenant('docs');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    c1 = await makeUser(tenant.id, 'COUNSELOR');
    c2 = await makeUser(tenant.id, 'COUNSELOR');
    t1 = await makeUser(tenant.id, 'TELECALLER');
    mine = await makeLead(tenant.id, { counselorId: c1.id, name: 'Mine' });
    theirs = await makeLead(tenant.id, { counselorId: c2.id, name: 'Theirs' });
    adminCtx = ctxFor(admin);
    c1Ctx = ctxFor(c1);
    c2Ctx = ctxFor(c2);
  });

  afterEach(() => setScannerForTests(undefined));

  const keyOf = async (id: string) =>
    (await ownerDb().document.findFirstOrThrow({ where: { id } })).storageKey;
  const stored = async (id: string) => getObjectStore().head(await keyOf(id));
  const audits = (action: string) => ownerDb().auditLog.count({ where: { tenantId: tenant.id, action } });

  it('upload → scan → checklist → signed download that is audited', async () => {
    const id = await upload(c1Ctx, 'passport.pdf', PDF, { studentId: mine.student.id, docType: 'PASSPORT' });
    expect(await stateOf(c1Ctx, id)).toBe('ready');

    const list = await documents.getChecklist(c1Ctx, mine.student.id);
    const passport = list.items.find((i) => i.docType === 'PASSPORT')!;
    expect(passport.status).toBe('UPLOADED');
    expect(passport.document?.id).toBe(id);
    expect(list.items.filter((i) => i.status === 'MISSING')).toHaveLength(7);

    const link = await documents.documentUrl(c1Ctx, id, 'attachment');
    const res = await fetch(link.url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF);
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="passport.pdf"');

    expect(await audits('document.upload_started')).toBe(1);
    expect(await audits('document.uploaded')).toBe(1);
    expect(await audits('document.scanned')).toBe(1);
    expect(await audits('document.downloaded')).toBe(1);
    const timeline = await ownerDb().activity.findMany({
      where: { studentId: mine.student.id, type: 'DOCUMENT' },
    });
    expect(timeline.map((a) => a.summary)).toEqual(['Passport uploaded: passport.pdf']);
  });

  it('an infected file never becomes downloadable and is removed from storage', async () => {
    const id = await upload(c1Ctx, 'passport.txt', Buffer.from(EICAR), {
      studentId: mine.student.id,
      docType: 'PASSPORT',
    });
    expect(await stateOf(c1Ctx, id)).toBe('blocked');
    const row = await ownerDb().document.findFirstOrThrow({ where: { id } });
    expect(row.scanStatus).toBe('INFECTED');
    expect(row.scanSignature).toMatch(/Eicar/i);
    expect(await code(documents.documentUrl(c1Ctx, id, 'attachment'))).toBe('CONFLICT');
    expect(await stored(id)).toBeNull();
    expect(row.purgedAt).not.toBeNull();

    const passport = (await documents.getChecklist(c1Ctx, mine.student.id)).items.find(
      (i) => i.docType === 'PASSPORT',
    )!;
    expect(passport.status).toBe('REJECTED');
    expect(
      await code(documents.reviewChecklistItem(c1Ctx, mine.student.id, 'PASSPORT', { status: 'VERIFIED' })),
    ).toBe('CONFLICT');
    expect(await audits('document.downloaded')).toBe(0);
  });

  it('a file that is not what it claims to be is refused', async () => {
    const id = await upload(c1Ctx, 'marks.pdf', Buffer.from('this is plain text, not a PDF'), {
      studentId: mine.student.id,
      docType: 'MARKS_MEMO',
    });
    expect(await stateOf(c1Ctx, id)).toBe('rejected');
    expect(await code(documents.documentUrl(c1Ctx, id, 'attachment'))).toBe('CONFLICT');
    expect(await stored(id)).toBeNull();
  });

  it('only the declared type and size can be uploaded to storage', async () => {
    const init = await documents.initUpload(c1Ctx, {
      filename: 'photo.png',
      mimeType: '',
      sizeBytes: PNG.length,
      studentId: mine.student.id,
      docType: 'PHOTO',
    });
    const send = (body: Buffer, type: string) =>
      fetch(init.upload.url, {
        method: 'PUT',
        headers: { 'Content-Type': type },
        body: new Uint8Array(body),
      });
    expect((await send(Buffer.concat([PNG, PNG]), 'image/png')).status).toBe(403); // other size
    expect((await send(PNG, 'application/pdf')).status).toBe(403); // other type
    // Nothing arrived, so completing is refused.
    expect(await code(documents.completeUpload(c1Ctx, init.document.id))).toBe('CONFLICT');
    expect((await send(PNG, 'image/png')).status).toBe(200);
    await documents.completeUpload(c1Ctx, init.document.id);
    expect(await stateOf(c1Ctx, init.document.id)).toBe('ready');
  });

  it('only accepted types and sizes start an upload', async () => {
    const base = { mimeType: '', sizeBytes: 100, studentId: mine.student.id, docType: 'PHOTO' as const };
    expect(await code(documents.initUpload(c1Ctx, { ...base, filename: 'virus.exe' }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      await code(
        documents.initUpload(c1Ctx, { ...base, filename: 'photo.jpg', mimeType: 'application/pdf' }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      await code(documents.initUpload(c1Ctx, { ...base, filename: 'big.pdf', sizeBytes: 21 * 1024 * 1024 })),
    ).toBe('VALIDATION_ERROR');
    expect(
      await code(documents.initUpload(c1Ctx, { ...base, filename: 'ok.jpg', mimeType: 'image/jpg' })),
    ).toBe('OK');
  });

  it('without a reachable scanner a file stays pending, and is released by a later scan', async () => {
    setScannerForTests({
      scan: () => Promise.reject(new ScannerUnavailableError('The scanner is down.')),
    });
    const id = await upload(c1Ctx, 'visa.pdf', PDF, { studentId: mine.student.id, docType: 'VISA' });
    expect(await stateOf(c1Ctx, id)).toBe('checking');
    const row = await ownerDb().document.findFirstOrThrow({ where: { id } });
    expect(row.scanAttempts).toBe(1);
    expect(row.scanError).toBe('The scanner is down.');
    expect(await code(documents.documentUrl(c1Ctx, id, 'attachment'))).toBe('CONFLICT');

    setScannerForTests(null); // nothing configured at all: still never released
    await maintainDocuments(tenant.id, new Date(Date.now() + 10 * 60_000));
    expect(await stateOf(c1Ctx, id)).toBe('checking');

    setScannerForTests(undefined); // the real scanner is back
    const result = await maintainDocuments(tenant.id, new Date(Date.now() + 20 * 60_000));
    expect(result.requeued).toBe(1);
    expect(await stateOf(c1Ctx, id)).toBe('ready');
  });

  it('a counselor reaches only the documents of their own leads', async () => {
    const id = await upload(c1Ctx, 'passport.pdf', PDF, { studentId: mine.student.id, docType: 'PASSPORT' });
    // Another counselor sees nothing of it: 404, not 403.
    expect(await code(documents.getChecklist(c2Ctx, mine.student.id))).toBe('NOT_FOUND');
    expect(await code(documents.documentUrl(c2Ctx, id, 'attachment'))).toBe('NOT_FOUND');
    expect(await code(documents.getDocument(c2Ctx, id))).toBe('NOT_FOUND');
    expect(await code(documents.deleteDocument(c2Ctx, id))).toBe('NOT_FOUND');
    expect(await code(upload(c2Ctx, 'x.pdf', PDF, { studentId: mine.student.id, docType: 'VISA' }))).toBe(
      'NOT_FOUND',
    );
    expect(
      await code(documents.reviewChecklistItem(c2Ctx, mine.student.id, 'PASSPORT', { status: 'VERIFIED' })),
    ).toBe('NOT_FOUND');
    // They can work on their own, and an admin on anyone's.
    await upload(c2Ctx, 'passport.pdf', PDF, { studentId: theirs.student.id, docType: 'PASSPORT' });
    expect(await code(documents.getChecklist(adminCtx, mine.student.id))).toBe('OK');
    // Telecallers have no access, and counselors no folder vault.
    expect(await code(documents.getChecklist(ctxFor(t1), mine.student.id))).toBe('FORBIDDEN');
    expect(await code(documents.createFolder(c1Ctx, { name: 'Brochures' }))).toBe('FORBIDDEN');
    expect(await code(documents.listFolders(c1Ctx))).toBe('FORBIDDEN');
    expect(await code(documents.listDocuments(c1Ctx, {}))).toBe('FORBIDDEN');
    expect(await code(upload(c1Ctx, 'x.pdf', PDF, {}))).toBe('FORBIDDEN');
  });

  it('another workspace cannot reach a document', async () => {
    const id = await upload(c1Ctx, 'passport.pdf', PDF, { studentId: mine.student.id, docType: 'PASSPORT' });
    const other = await makeTenant('docs-other');
    const otherAdmin = await makeUser(other.id, 'TENANT_ADMIN');
    expect(await code(documents.documentUrl(ctxFor(otherAdmin), id, 'attachment'))).toBe('NOT_FOUND');
    expect(await code(documents.getChecklist(ctxFor(otherAdmin), mine.student.id))).toBe('NOT_FOUND');
  });

  it('a new upload for a checklist item is a new version and asks for review again', async () => {
    const v1 = await upload(c1Ctx, 'passport.pdf', PDF, { studentId: mine.student.id, docType: 'PASSPORT' });
    await documents.reviewChecklistItem(c1Ctx, mine.student.id, 'PASSPORT', { status: 'VERIFIED' });
    const v2 = await upload(c1Ctx, 'passport-new.pdf', Buffer.concat([PDF, Buffer.from('2')]), {
      studentId: mine.student.id,
      docType: 'PASSPORT',
    });
    const detail = await documents.getDocument(c1Ctx, v2);
    expect(detail.document.version).toBe(2);
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail.document.seriesId).toBe((await documents.getDocument(c1Ctx, v1)).document.seriesId);

    const item = (await documents.getChecklist(c1Ctx, mine.student.id)).items.find(
      (i) => i.docType === 'PASSPORT',
    )!;
    expect(item.document?.id).toBe(v2);
    expect(item.status).toBe('UPLOADED'); // not verified any more
    expect(item.versionCount).toBe(2);
    // The old version is still there, still clean.
    expect(await code(documents.documentUrl(c1Ctx, v1, 'attachment'))).toBe('OK');
  });

  it('review rules: verify needs a clean file, reject needs a reason', async () => {
    await upload(c1Ctx, 'passport.pdf', PDF, { studentId: mine.student.id, docType: 'PASSPORT' });
    expect(
      await code(documents.reviewChecklistItem(c1Ctx, mine.student.id, 'PASSPORT', { status: 'REJECTED' })),
    ).toBe('VALIDATION_ERROR');
    expect(
      await code(
        documents.reviewChecklistItem(c1Ctx, mine.student.id, 'PASSPORT', {
          status: 'REJECTED',
          note: 'Blurry scan',
        }),
      ),
    ).toBe('OK');
    let item = (await documents.getChecklist(c1Ctx, mine.student.id)).items.find(
      (i) => i.docType === 'PASSPORT',
    )!;
    expect([item.status, item.note]).toEqual(['REJECTED', 'Blurry scan']);
    await documents.reviewChecklistItem(c1Ctx, mine.student.id, 'PASSPORT', { status: 'VERIFIED' });
    item = (await documents.getChecklist(c1Ctx, mine.student.id)).items.find(
      (i) => i.docType === 'PASSPORT',
    )!;
    expect(item.status).toBe('VERIFIED');
    expect(item.reviewedBy).toBeTruthy();
    // Nothing uploaded for the visa yet.
    expect(
      await code(documents.reviewChecklistItem(c1Ctx, mine.student.id, 'VISA', { status: 'VERIFIED' })),
    ).toBe('CONFLICT');
    expect(await audits('document.reviewed')).toBe(2); // the refused ones leave no row
  });

  it('folders: nesting, unique names, rename, delete only when empty', async () => {
    const root = await documents.createFolder(adminCtx, { name: 'Admissions 2026' });
    const child = await documents.createFolder(adminCtx, { name: 'Georgia', parentId: root.id });
    expect(await code(documents.createFolder(adminCtx, { name: 'admissions 2026' }))).toBe('CONFLICT');
    expect(await code(documents.createFolder(adminCtx, { name: 'Georgia', parentId: root.id }))).toBe(
      'CONFLICT',
    );
    expect(await code(documents.createFolder(adminCtx, { name: 'Georgia' }))).toBe('OK'); // same name, another parent

    const listing = await documents.listFolders(adminCtx, root.id);
    expect(listing.breadcrumb.map((f) => f.name)).toEqual(['Admissions 2026']);
    expect(listing.folders.map((f) => f.name)).toEqual(['Georgia']);
    expect((await documents.listFolders(adminCtx)).folders.find((f) => f.id === root.id)?.folderCount).toBe(
      1,
    );

    await documents.renameFolder(adminCtx, child.id, 'Georgia (Tbilisi)');
    const id = await upload(adminCtx, 'fees.pdf', PDF, { folderId: child.id });
    expect(await code(documents.deleteFolder(adminCtx, child.id))).toBe('CONFLICT'); // has a file
    expect(await code(documents.deleteFolder(adminCtx, root.id))).toBe('CONFLICT'); // has a folder
    await documents.deleteDocument(adminCtx, id);
    expect(await code(documents.deleteFolder(adminCtx, child.id))).toBe('OK');
    expect(await code(documents.deleteFolder(adminCtx, root.id))).toBe('OK');
    expect(await code(documents.listFolders(adminCtx, root.id))).toBe('NOT_FOUND');

    let parent = (await documents.createFolder(adminCtx, { name: 'Level 1' })).id;
    for (let depth = 2; depth <= 8; depth++) {
      parent = (await documents.createFolder(adminCtx, { name: `Level ${depth}`, parentId: parent })).id;
    }
    expect(await code(documents.createFolder(adminCtx, { name: 'Too deep', parentId: parent }))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('vault files: versions, search, and a deleted file is purged after the retention period', async () => {
    const folder = await documents.createFolder(adminCtx, { name: 'Brochures' });
    const v1 = await upload(adminCtx, 'brochure.pdf', PDF, { folderId: folder.id });
    const v2 = await upload(adminCtx, 'brochure.pdf', Buffer.concat([PDF, Buffer.from('v2')]), {
      replaces: v1,
    });
    expect((await documents.getDocument(adminCtx, v2)).document.version).toBe(2);

    const inFolder = await documents.listDocuments(adminCtx, { folderId: folder.id });
    expect(inFolder.documents).toHaveLength(1);
    expect(inFolder.documents[0]).toMatchObject({ id: v2, version: 2, versionCount: 2, state: 'ready' });
    expect((await documents.listDocuments(adminCtx, {})).documents).toHaveLength(0); // root is empty
    expect((await documents.listDocuments(adminCtx, { q: 'BROCH' })).documents).toHaveLength(1);

    const key1 = await keyOf(v1);
    const key2 = await keyOf(v2);
    await documents.deleteDocument(adminCtx, v2);
    expect(await code(documents.getDocument(adminCtx, v1))).toBe('NOT_FOUND'); // every version goes
    expect((await documents.listDocuments(adminCtx, { folderId: folder.id })).documents).toHaveLength(0);

    // Still in storage during the retention period; removed after it.
    const store = getObjectStore();
    expect((await maintainDocuments(tenant.id, new Date(Date.now() + 5 * 86_400_000))).purged).toBe(0);
    expect(await store.head(key1)).not.toBeNull();
    expect((await maintainDocuments(tenant.id, new Date(Date.now() + 31 * 86_400_000))).purged).toBe(2);
    expect(await store.head(key1)).toBeNull();
    expect(await store.head(key2)).toBeNull();
  });

  it('removing a checklist file puts the item back to missing; abandoned uploads are dropped', async () => {
    const id = await upload(c1Ctx, 'visa.pdf', PDF, { studentId: mine.student.id, docType: 'VISA' });
    await documents.deleteDocument(c1Ctx, id);
    const item = (await documents.getChecklist(c1Ctx, mine.student.id)).items.find(
      (i) => i.docType === 'VISA',
    )!;
    expect([item.status, item.document]).toEqual(['MISSING', null]);

    const started = await documents.initUpload(c1Ctx, {
      filename: 'never-finished.pdf',
      mimeType: '',
      sizeBytes: PDF.length,
      studentId: mine.student.id,
      docType: 'PHOTO',
    });
    const result = await maintainDocuments(tenant.id, new Date(Date.now() + 25 * 3_600_000));
    expect(result.abandoned).toBe(1);
    const row = await ownerDb().document.findFirstOrThrow({ where: { id: started.document.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('other documents of a student are listed apart from the checklist', async () => {
    await upload(c1Ctx, 'fee-letter.pdf', PDF, { studentId: mine.student.id });
    await upload(c1Ctx, 'old-passport.pdf', PDF, { studentId: mine.student.id, docType: 'PASSPORT' });
    const list = await documents.getChecklist(c1Ctx, mine.student.id);
    expect(list.others.map((o) => o.filename)).toEqual(['fee-letter.pdf']);
    expect(list.items.find((i) => i.docType === 'PASSPORT')?.document?.filename).toBe('old-passport.pdf');
  });
});
