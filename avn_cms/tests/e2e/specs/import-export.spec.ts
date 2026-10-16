import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { as, expectAccessible, testPhone } from './helpers';

const csvFile = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(',')).join('\n'), 'utf8');

test.describe('admin: import wizard', () => {
  test.use(as('admin'));

  test('upload → match columns → check problems → import → students appear', async ({ page }) => {
    const good1 = testPhone();
    const good2 = testPhone();
    const names = [`Wizard One ${good1.slice(-4)}`, `Wizard Two ${good1.slice(-4)}`];
    const file = csvFile([
      ['Student Name', 'Mobile', 'City', 'Status', 'Counsellor', 'Remarks'],
      [names[0]!, good1, 'Guntur', 'Interested', '', 'from the wizard test'],
      [names[1]!, good2, 'Vijayawada', 'New', '', ''],
      ['Broken row', '123', '', '', '', ''],
    ]);

    await page.goto('/app/imports');
    await expectAccessible(page);
    await page.getByRole('link', { name: 'New import' }).click();
    await page
      .getByLabel('Spreadsheet file')
      .setInputFiles({ name: 'students.csv', mimeType: 'text/csv', buffer: file });
    await page.getByRole('button', { name: 'Upload and continue' }).click();

    // Step 2: the columns were recognised from their headers.
    await expect(page.getByRole('heading', { name: 'Map columns to fields' })).toBeVisible();
    await expect(page.getByLabel('Student name')).toHaveValue('0');
    await expect(page.getByLabel('Mobile number')).toHaveValue('1');
    await page.getByLabel('Default source').selectOption({ label: 'Website' });
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Check file' }).click();

    // Step 3: nothing is saved yet; the bad row is reported and will be skipped.
    await expect(page.getByRole('heading', { name: 'Check results' })).toBeVisible();
    const check = page.locator('dl[aria-label="Check summary"]');
    await expect(check.locator('dd').nth(0)).toHaveText('3'); // rows in file
    await expect(check.locator('dd').nth(1)).toHaveText('2'); // ready to import
    await expect(check.locator('dd').nth(4)).toHaveText('1'); // need fixing
    await expect(page.getByText('Line 4', { exact: true })).toBeVisible();
    await expectAccessible(page);

    // Step 4: import with the safe default, then the new students are in the workspace.
    await page.getByRole('button', { name: 'Start import' }).click();
    await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('dl[aria-label="Import summary"]').locator('dd').nth(0)).toHaveText('2');
    await expectAccessible(page);

    const [report] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download problem list' }).click(),
    ]);
    expect(report.suggestedFilename()).toBe('students-problems.csv');

    await page.goto('/app/leads');
    await page.getByLabel('Search leads').fill(good1.slice(-6));
    await expect(page.getByRole('link', { name: names[0]! })).toBeVisible();
  });

  test('the import list shows the finished import', async ({ page }) => {
    await page.goto('/app/imports');
    await expect(page.getByRole('cell', { name: 'students.csv' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Finished' })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe('admin: exports', () => {
  test.use(as('admin'));

  test('export from the leads screen downloads a file, and the exports list keeps it', async ({ page }) => {
    await page.goto('/app/leads');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export leads' });
    await dialog.getByLabel('Excel (.xlsx)').check();
    await dialog.getByRole('button', { name: 'Prepare export' }).click();
    await expect(dialog.getByText('Your file is ready')).toBeVisible({ timeout: 30_000 });

    const [file] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Download Excel' }).click(),
    ]);
    expect(file.suggestedFilename()).toMatch(/^leads-.*\.xlsx$/);

    await page.goto('/app/exports');
    await expect(page.getByRole('heading', { name: 'Exports' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Leads · Excel' }).first()).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe('telecaller: exports without import access', () => {
  test.use(as('telecaller1'));

  test('gets no import screens and a reduced export without contact details', async ({ page }) => {
    await page.goto('/app/imports');
    await expect(page.getByText('Only admins can import students.')).toBeVisible();

    await page.goto('/app/leads');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export leads' });
    await dialog.getByRole('button', { name: 'Prepare export' }).click();
    await expect(dialog.getByText('Your file is ready')).toBeVisible({ timeout: 30_000 });

    const [file] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Download CSV' }).click(),
    ]);
    const header = readFileSync((await file.path())!, 'utf8').split('\n')[0] ?? '';
    expect(header).toContain('Student name');
    expect(header).not.toMatch(/Email|Address/);
  });
});
