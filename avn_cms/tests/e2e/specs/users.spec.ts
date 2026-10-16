import { expect, test } from '@playwright/test';

import { as, expectAccessible } from './helpers';

test.describe('admin manages users', () => {
  test.use(as('admin'));

  test('add a counselor → invite link → they set a password and sign in with counselor access', async ({
    page,
    browser,
  }) => {
    await page.goto('/app/users');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Add user' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Name').fill('Neha New');
    await d.getByLabel('Email').fill('neha.new@demo.test');
    await d.getByLabel('Role').selectOption('COUNSELOR');
    await d.getByRole('button', { name: 'Add user' }).click();
    // Email is off in e2e, so the admin is shown the one-time link instead of a false "sent".
    const notice = page.getByRole('status').filter({ hasText: 'Email isn' });
    await expect(notice).toBeVisible();
    const link = (await notice.locator('code').textContent())!.trim();
    expect(link).toMatch(/\/reset-password\//);

    // A signed-out browser (Playwright would otherwise apply the admin storage state).
    const fresh = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const p = await fresh.newPage();
    await p.goto(link);
    await p.getByLabel(/^New password/).fill('Neha-Password-2026');
    await p.getByLabel('Repeat new password').fill('Neha-Password-2026');
    await p.getByRole('button', { name: 'Set new password' }).click();
    await expect(p).toHaveURL(/\/login\?reset=1/);
    await p.getByLabel('Workspace').fill('demo');
    await p.getByLabel('Email').fill('neha.new@demo.test');
    await p.getByLabel('Password').fill('Neha-Password-2026');
    await p.getByRole('button', { name: 'Sign in' }).click();
    await expect(p).toHaveURL(/\/app\/dashboard$/);
    await expect(
      p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Users' }),
    ).toHaveCount(0);
    // The link is single-use.
    await p.goto(link);
    await p.getByLabel(/^New password/).fill('Another-Password-2026');
    await p.getByLabel('Repeat new password').fill('Another-Password-2026');
    await p.getByRole('button', { name: 'Set new password' }).click();
    await expect(p.getByText('This reset link is invalid or has expired')).toBeVisible();
    await fresh.close();
  });

  test('settings and audit log are reachable and accessible', async ({ page }) => {
    await page.goto('/app/settings');
    await expect(page.getByRole('heading', { name: 'Lead sources' })).toBeVisible();
    await expectAccessible(page);
    await page.goto('/app/audit');
    await expect(page.getByText('user.create').first()).toBeVisible();
    await expectAccessible(page);
    await page.goto('/app/account');
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe('super admin', () => {
  test.use(as('superadmin'));

  test('platform overview → open an agency as admin (banner, audited) → stop', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/platform$/);
    await expectAccessible(page);
    const row = page.getByRole('row').filter({ hasText: 'Demo Agency (test data)' });
    await row.getByRole('button', { name: 'Open as admin' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);
    await expect(page.getByText(/You are acting as/)).toBeVisible();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page).toHaveURL(/\/platform$/);
  });
});
