import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { as, expectAccessible, expectNoSidewaysScroll } from './helpers';

/**
 * Documents vault through a real browser: the file goes straight from the page to storage with a
 * presigned URL, is scanned by ClamAV, and only then can be downloaded. The antivirus test string is
 * assembled at run time so this file never contains it whole.
 */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');
const pdf = (note: string) => Buffer.from(`%PDF-1.4\n% ${note}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);

/** Opens the first lead in the list and its Documents tab. */
async function openDocuments(page: Page) {
  await page.goto('/app/leads');
  await page.locator('tbody a[href^="/app/leads/"]').first().click();
  await expect(page).toHaveURL(/\/app\/leads\/[0-9a-f-]{36}$/);
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { name: 'Document checklist' })).toBeVisible();
}

test.describe('admin: a student’s documents', () => {
  test.use(as('admin'));

  test('upload → scan → download → verify → new version; an infected file is blocked', async ({ page }) => {
    await openDocuments(page);
    const passport = page.getByTestId('doc-PASSPORT');
    const original = pdf('passport v1');

    // The page sends the file to storage, the server scans it, then it can be downloaded.
    await page.getByLabel('Upload Passport').setInputFiles({
      name: 'passport.pdf',
      mimeType: 'application/pdf',
      buffer: original,
    });
    await expect(passport.getByText('passport.pdf')).toBeVisible();
    await expect(passport.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(passport.getByText('Uploaded', { exact: true })).toBeVisible();
    await expectAccessible(page);

    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download Passport' }).click(),
    ]);
    expect(file.suggestedFilename()).toBe('passport.pdf');
    expect(readFileSync((await file.path())!)).toEqual(original);

    await page.getByRole('button', { name: 'Verify Passport' }).click();
    await expect(passport.getByText('Verified', { exact: true })).toBeVisible();

    // A new copy is version 2, and needs checking again.
    await page.getByLabel('Replace Passport').setInputFiles({
      name: 'passport-new.pdf',
      mimeType: 'application/pdf',
      buffer: pdf('passport v2'),
    });
    await expect(passport.getByText('passport-new.pdf')).toBeVisible({ timeout: 30_000 });
    await expect(passport.getByText(/version 2 of 2/)).toBeVisible();
    await expect(passport.getByText('Uploaded', { exact: true })).toBeVisible();

    // An infected file is never offered for download.
    const neet = page.getByTestId('doc-NEET_RESULT');
    await page.getByLabel('Upload NEET result').setInputFiles({
      name: 'neet.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(EICAR),
    });
    await expect(neet.getByText('Blocked', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(neet.getByText('This file failed the safety scan and was removed.')).toBeVisible();
    await expect(neet.getByText('Rejected', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download NEET result' })).toHaveCount(0);
    await expectAccessible(page);

    // Files that are not accepted are refused before anything is sent.
    await page.getByLabel('Upload Photo').setInputFiles({
      name: 'photo.exe',
      mimeType: 'application/x-msdownload',
      buffer: Buffer.from('MZ'),
    });
    await expect(page.getByTestId('doc-PHOTO').getByText(/isn’t accepted/)).toBeVisible();
  });
});

test.describe('counselor and telecaller', () => {
  test('a counselor works on their own leads only', async ({ browser }) => {
    const mine = await browser.newContext(as('counselor1'));
    const theirs = await browser.newContext(as('counselor2'));
    const page = await mine.newPage();
    try {
      const other = await (await theirs.request.get('/api/students?limit=1')).json();
      const otherStudentId = other.data[0].student.id as string;
      // Another counselor's student: not found, not forbidden.
      expect((await mine.request.get(`/api/students/${otherStudentId}/documents`)).status()).toBe(404);
      // No folder vault for counselors: no link, and the page says so.
      await page.goto('/app/leads');
      await expect(
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents' }),
      ).toHaveCount(0);
      await page.goto('/app/documents');
      await expect(page.getByText('Only admins manage the folder vault.')).toBeVisible();
      // Their own lead has the tab and the checklist.
      await openDocuments(page);
      await expect(page.getByTestId('doc-VISA')).toBeVisible();
    } finally {
      await mine.close();
      await theirs.close();
    }
  });

  test.describe('telecaller', () => {
    test.use(as('telecaller1'));
    test('has no document access', async ({ page }) => {
      await page.goto('/app/followups');
      await expect(
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents' }),
      ).toHaveCount(0);
      const lead = await (await page.request.get('/api/students?limit=1')).json();
      const response = await page.request.get(`/api/students/${lead.data[0].student.id}/documents`);
      expect(response.status()).toBe(403);
    });
  });
});

test.describe('admin: folder vault', () => {
  test.use(as('admin'));

  test('folders, files, versions and downloads', async ({ page }) => {
    const folderName = `Brochures ${Date.now().toString().slice(-5)}`;
    await page.goto('/app/documents');
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents' }),
    ).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByLabel('Folder name').fill(folderName);
    await page.getByRole('button', { name: 'Create folder' }).click();
    await expect(page.getByText(`Folder “${folderName}” created.`)).toBeVisible();
    await page.getByRole('link', { name: new RegExp(folderName) }).click();
    await expect(page.getByRole('navigation', { name: 'Folder path' }).getByText(folderName)).toBeVisible();

    const v1 = pdf('brochure v1');
    await page
      .getByLabel('Upload file')
      .setInputFiles({ name: 'georgia.pdf', mimeType: 'application/pdf', buffer: v1 });
    const row = page.getByRole('row', { name: /georgia\.pdf/ });
    await expect(row.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText('v1')).toBeVisible();

    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download georgia.pdf' }).click(),
    ]);
    expect(readFileSync((await file.path())!)).toEqual(v1);

    await page.getByLabel('New version of georgia.pdf').setInputFiles({
      name: 'georgia.pdf',
      mimeType: 'application/pdf',
      buffer: pdf('brochure v2'),
    });
    await expect(row.getByText('v2')).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page);

    // A folder with files in it cannot be deleted; the page says why.
    await page.getByRole('link', { name: 'All documents' }).click();
    await page.getByRole('button', { name: `Delete ${folderName}` }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Move or delete what is inside this folder first.')).toBeVisible();

    // Search finds the file from the top of the vault.
    await page.getByLabel('Search files').fill('georgia');
    await expect(page.getByRole('row', { name: /georgia\.pdf/ })).toBeVisible();

    // On a phone the file table scrolls inside its card; the page itself must not scroll sideways.
    await expectNoSidewaysScroll(page);
  });
});

test.describe('admin: files whose virus scan did not finish', () => {
  test.use(as('admin'));

  test('are listed with the reason, and “Scan again” releases them', async ({ page }) => {
    // Make a file the worker gave up on: the scanner cannot be made to fail in a real browser run,
    // so write the state a long outage leaves behind. Only ever into the *_test database.
    const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'] ?? '';
    expect(ownerUrl, 'TEST_DATABASE_OWNER_URL must name the *_test database').toMatch(/_test(\?|$)/);
    process.env['DATABASE_OWNER_URL'] = ownerUrl;
    process.env['R2_BUCKET'] = process.env['TEST_R2_BUCKET'] ?? process.env['R2_BUCKET'] ?? '';
    const { resetConfigForTests } = await import('@avn-cms/config');
    resetConfigForTests();
    const { ownerDb } = await import('../../../packages/db/src/owner');
    const { getObjectStore } = await import('../../../packages/core/src/documents/object-store');
    const db = ownerDb();
    const tenant = await db.tenant.findFirstOrThrow({ where: { slug: 'demo' } });
    const admin = await db.user.findFirstOrThrow({
      where: { tenantId: tenant.id, email: 'admin@demo.test' },
    });
    const id = randomUUID();
    const bytes = pdf('stuck brochure');
    const storageKey = `tenants/${tenant.id}/documents/${id}`;
    await getObjectStore().put(storageKey, bytes, 'application/pdf');
    await db.document.create({
      data: {
        id,
        tenantId: tenant.id,
        seriesId: id,
        filename: 'stuck-brochure.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(bytes.length),
        storageKey,
        uploadedById: admin.id,
        uploadedAt: new Date(Date.now() - 60 * 60_000),
        scanAttempts: 5,
        scanError: 'The scanner is down.',
        scannedAt: new Date(Date.now() - 10 * 60_000),
      },
    });

    await page.goto('/app/documents');
    const card = page.getByTestId('stuck-scans');
    await expect(card.getByText('1 file couldn’t be checked')).toBeVisible();
    await expect(card.getByText('stuck-brochure.pdf')).toBeVisible();
    await expect(card.getByText('Gave up')).toBeVisible();
    await expect(card.getByText(/5 of 5 tries/)).toBeVisible();
    await expect(card.getByText('The scanner is down.')).toBeVisible();
    await expectAccessible(page);
    await expectNoSidewaysScroll(page);

    // Blocked until it is checked: not in the file list, so nothing to download.
    await expect(page.getByRole('button', { name: 'Download stuck-brochure.pdf' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Scan again: stuck-brochure.pdf' }).click();
    await expect(page.getByTestId('stuck-scans')).toHaveCount(0, { timeout: 30_000 });
    const row = page.getByRole('row', { name: /stuck-brochure\.pdf/ });
    await expect(row.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Download stuck-brochure.pdf' })).toBeVisible();
  });

  test('a counselor cannot see or use them', async ({ browser }) => {
    const context = await browser.newContext(as('counselor1'));
    try {
      expect((await context.request.get('/api/documents/stuck')).status()).toBe(403);
    } finally {
      await context.close();
    }
  });
});
