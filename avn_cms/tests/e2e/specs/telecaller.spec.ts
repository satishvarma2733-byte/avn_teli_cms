import { expect, test } from '@playwright/test';

import { as, expectAccessible } from './helpers';

test.describe('a telecaller working the call queue', () => {
  test.use(as('telecaller1'));

  test('logs an outcome from the queue; the call leaves it and appears under Closed', async ({ page }) => {
    await page.goto('/app/followups?bucket=pending');
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Log outcome' }) })
      .first();
    await expect(row).toBeVisible();
    const name = (await row.getByRole('link').first().innerText()).trim();

    await row.getByRole('button', { name: 'Log outcome' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('What happened?').selectOption('NO_ANSWER');
    await dialog.getByLabel('Call notes').fill('Phone rang out, will try again (e2e)');
    await dialog.getByRole('button', { name: 'Save outcome' }).click();
    await expect(page.getByText(`Outcome saved for ${name}.`)).toBeVisible();

    await page.goto('/app/followups?bucket=closed');
    await expect(page.getByText('“Phone rang out, will try again (e2e)”').first()).toBeVisible();
    await expectAccessible(page);
  });

  test('sees their own numbers on the dashboard and no one else’s', async ({ page }) => {
    await page.goto('/app/dashboard');
    await expect(page.getByText('My queue today')).toBeVisible();
    await expect(page.getByText('Callbacks due')).toBeVisible();
    await expect(page.getByText('Total active leads')).toHaveCount(0);
    await expectAccessible(page);
  });
});
