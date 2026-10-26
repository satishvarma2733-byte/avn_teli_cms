import { expect, test } from '@playwright/test';

import { as, expectAccessible } from './helpers';

test.describe('plan and usage', () => {
  test.describe('an agency admin', () => {
    test.use(as('admin'));

    test('sees the plan and what the workspace has used of it', async ({ page }) => {
      await page.goto('/app/settings');
      await expect(page.getByRole('heading', { name: 'Plan and usage' })).toBeVisible();
      await expect(page.getByText(/ plan$/).first()).toBeVisible();
      for (const label of ['Active users', 'Leads', 'Stored documents']) {
        await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
      }
      await expectAccessible(page);
    });
  });

  test.describe('a counselor', () => {
    test.use(as('counselor1'));

    test('has no plan page and is refused the usage data', async ({ page }) => {
      await page.goto('/app/dashboard');
      const status = await page.evaluate(async () => (await fetch('/api/usage')).status);
      expect(status).toBe(403);
    });
  });

  test.describe('platform staff', () => {
    test.use(as('superadmin'));

    test('move an agency to another plan; a plan it does not fit is refused', async ({ page }) => {
      await page.goto('/platform');
      const row = page.getByRole('row').filter({ hasText: 'Demo Agency (test data)' });
      const openDialog = async () => {
        await row.getByRole('button', { name: /Change plan/ }).click();
        return page.getByRole('dialog');
      };

      // Starter allows 3 users; the demo agency has more, so the move is refused and says why.
      let dialog = await openDialog();
      await dialog.getByLabel('Plan').selectOption('STARTER');
      await dialog.getByRole('button', { name: 'Change plan' }).click();
      await expect(dialog.getByText(/can't move to Starter: it has \d+ active users/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();

      // A bigger plan is accepted, and the table shows it.
      dialog = await openDialog();
      await dialog.getByLabel('Plan').selectOption('ULTRA');
      await dialog.getByRole('button', { name: 'Change plan' }).click();
      await expect(page.getByText(/Demo Agency \(test data\) is now on the Ultra plan/)).toBeVisible();
      await expect(row.getByText('Ultra')).toBeVisible();

      // Put it back, so the other tests see the agency as it was.
      dialog = await openDialog();
      await dialog.getByLabel('Plan').selectOption('PROFESSIONAL');
      await dialog.getByRole('button', { name: 'Change plan' }).click();
      await expect(page.getByText(/is now on the Professional plan/)).toBeVisible();
      await expectAccessible(page);
    });
  });
});
