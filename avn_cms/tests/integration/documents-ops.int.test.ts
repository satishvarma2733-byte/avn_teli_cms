import { resetConfigForTests } from '@avn-cms/config';
import {
  AppError,
  documents,
  documentsHealth,
  getObjectStore,
  listStuckScans,
  maintainDocuments,
  rescanDocument,
  ScannerUnavailableError,
  setScannerForTests,
} from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as health } from '@/app/api/health/route';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

/**
 * Operations around the documents vault, on the real MinIO and ClamAV: files whose scan did not
 * finish can be seen and retried by an admin, and storage and scanner health are reported without
 * ever failing the health check.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

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
async function upload(
  ctx: Ctx,
  filename: string,
  target: { studentId?: string; folderId?: string | null; docType?: 'PASSPORT' },
) {
  const init = await documents.initUpload(ctx, { filename, mimeType: '', sizeBytes: PDF.length, ...target });
  const res = await fetch(init.upload.url, {
    method: init.upload.method,
    headers: init.upload.headers,
    body: new Uint8Array(PDF),
  });
  expect(res.status).toBe(200);
  await documents.completeUpload(ctx, init.document.id);
  return init.document.id;
}

const scannerDown = () =>
  setScannerForTests({ scan: () => Promise.reject(new ScannerUnavailableError('The scanner is down.')) });

describe('files whose scan did not finish', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let counselor: Awaited<ReturnType<typeof makeUser>>;
  let student: { id: string; name: string };
  let adminCtx: Ctx;

  beforeEach(async () => {
    const store = getObjectStore();
    for (const d of await ownerDb().document.findMany({ select: { storageKey: true } })) {
      await store.remove(d.storageKey);
    }
    await resetData();
    tenant = await makeTenant('ops');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    counselor = await makeUser(tenant.id, 'COUNSELOR');
    student = (await makeLead(tenant.id, { counselorId: counselor.id, name: 'Stuck Student' })).student;
    adminCtx = ctxFor(admin);
  });

  afterEach(() => setScannerForTests(undefined));

  const audits = (action: string) => ownerDb().auditLog.count({ where: { tenantId: tenant.id, action } });
  const stateOf = async (id: string) => (await documents.getDocument(adminCtx, id)).document.state;

  it('lists a file while it is retried, then as given up, and a new try releases it', async () => {
    expect((await listStuckScans(adminCtx)).stuck).toEqual([]);

    scannerDown();
    const id = await upload(ctxFor(counselor), 'passport.pdf', {
      studentId: student.id,
      docType: 'PASSPORT',
    });

    const first = await listStuckScans(adminCtx);
    expect(first.maxAttempts).toBe(5);
    let stuck = first.stuck;
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({
      id,
      filename: 'passport.pdf',
      attempts: 1,
      exhausted: false,
      error: 'The scanner is down.',
      student: { id: student.id, name: 'Stuck Student' },
      folder: null,
    });
    expect(stuck[0]?.student?.leadId).toBeTruthy();

    // The worker keeps trying, then stops at five.
    for (let k = 1; k <= 4; k++) {
      const result = await maintainDocuments(tenant.id, new Date(Date.now() + k * 10 * 60_000));
      expect(result.requeued).toBe(1);
    }
    ({ stuck } = await listStuckScans(adminCtx));
    expect(stuck[0]).toMatchObject({ attempts: 5, exhausted: true });
    expect((await maintainDocuments(tenant.id, new Date(Date.now() + 90 * 60_000))).requeued).toBe(0);
    expect(await stateOf(id)).toBe('checking');

    // The scanner is back; an admin asks for another try.
    setScannerForTests(undefined);
    await rescanDocument(adminCtx, id);
    expect(await stateOf(id)).toBe('ready');
    expect((await listStuckScans(adminCtx)).stuck).toEqual([]);
    const row = await ownerDb().document.findFirstOrThrow({ where: { id } });
    expect(row.scanError).toBeNull();
    expect(await audits('document.rescan_requested')).toBe(1);
  });

  it('shows a vault file with its folder, and a failing retry stays listed with the new reason', async () => {
    const folder = await documents.createFolder(adminCtx, { name: 'Brochures' });
    scannerDown();
    const id = await upload(adminCtx, 'brochure.pdf', { folderId: folder.id });
    const { stuck } = await listStuckScans(adminCtx);
    expect(stuck[0]).toMatchObject({ id, student: null, folder: { id: folder.id, name: 'Brochures' } });

    setScannerForTests({ scan: () => Promise.reject(new ScannerUnavailableError('Still down.')) });
    await rescanDocument(adminCtx, id);
    const again = (await listStuckScans(adminCtx)).stuck[0];
    expect(again).toMatchObject({ attempts: 1, exhausted: false, error: 'Still down.' });
  });

  it('is for admins only, within their own workspace, and only for files still waiting', async () => {
    scannerDown();
    const stuckId = await upload(adminCtx, 'waiting.pdf', {});
    setScannerForTests(undefined);
    const cleanId = await upload(adminCtx, 'fine.pdf', {});
    expect(await stateOf(cleanId)).toBe('ready');

    const counselorCtx = ctxFor(counselor);
    expect(await code(listStuckScans(counselorCtx))).toBe('FORBIDDEN');
    expect(await code(rescanDocument(counselorCtx, stuckId))).toBe('FORBIDDEN');
    expect(await code(listStuckScans(ctxFor(await makeUser(tenant.id, 'TELECALLER'))))).toBe('FORBIDDEN');

    const otherAdmin = await makeUser((await makeTenant('ops-other')).id, 'TENANT_ADMIN');
    expect((await listStuckScans(ctxFor(otherAdmin))).stuck).toEqual([]);
    expect(await code(rescanDocument(ctxFor(otherAdmin), stuckId))).toBe('NOT_FOUND');

    expect(await code(rescanDocument(adminCtx, cleanId))).toBe('CONFLICT'); // already checked
    expect(await code(rescanDocument(adminCtx, '00000000-0000-4000-8000-000000000000'))).toBe('NOT_FOUND');
  });
});

describe('storage and scanner health', () => {
  const KEYS = [
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'CLAMAV_HOST',
    'CLAMAV_PORT',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigForTests();
    await documentsHealth({ fresh: true }); // do not leave a broken answer in the cache
  });

  it('is up when both answer', async () => {
    expect(await documentsHealth({ fresh: true })).toEqual({ storage: 'up', scanner: 'up' });
  });

  it('says down, quickly, when they do not answer', async () => {
    process.env['R2_ENDPOINT'] = 'http://127.0.0.1:1';
    process.env['CLAMAV_HOST'] = '127.0.0.1';
    process.env['CLAMAV_PORT'] = '1';
    resetConfigForTests();
    const started = Date.now();
    expect(await documentsHealth({ fresh: true })).toEqual({ storage: 'down', scanner: 'down' });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('says not configured (not down) when documents are not set up', async () => {
    for (const k of KEYS) delete process.env[k];
    resetConfigForTests();
    expect(await documentsHealth({ fresh: true })).toEqual({
      storage: 'not_configured',
      scanner: 'not_configured',
    });
  });

  it('is reported by /api/health without ever failing it', async () => {
    process.env['R2_ENDPOINT'] = 'http://127.0.0.1:1';
    process.env['CLAMAV_PORT'] = '1';
    resetConfigForTests();
    await documentsHealth({ fresh: true }); // fills the short-lived cache the route reads
    const res = await health();
    expect(res.status).toBe(200); // the database is fine; documents being down is not a reason to leave rotation
    expect(await res.json()).toEqual({
      status: 'ok',
      database: 'up',
      redis: 'not_configured',
      storage: 'down',
      scanner: 'down',
      worker: 'not_configured',
    });
  });
});
