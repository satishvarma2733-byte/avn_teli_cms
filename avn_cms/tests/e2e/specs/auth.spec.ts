import { expect, test } from '@playwright/test';

import { E2E_PASSWORD } from '../global-setup';

import { expectAccessible } from './helpers';

test.describe('sign-in', () => {
  test('wrong password is refused with a generic message; correct one lands on the dashboard', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle(/Sign in · aVn CMS/);
    await expectAccessible(page);
    await page.getByLabel('Workspace').fill('demo');
    await page.getByLabel('Email').fill('admin@demo.test');
    await page.getByLabel('Password').fill('not-the-password-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('The workspace, email or password is incorrect.')).toBeVisible();

    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Good to see you');
  });

  test('telecallers land on their call queue', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Workspace').fill('demo');
    await page.getByLabel('Email').fill('telecaller2@demo.test');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app\/followups$/);
  });

  test('signed-out visitors are sent to sign-in, and the API answers 401', async ({ page, request }) => {
    await page.goto('/app/leads');
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fleads/);
    const res = await request.get('/api/students');
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  test('pages carry a CSP with a per-request nonce and no inline-script allowance', async ({ request }) => {
    const a = await request.get('/login');
    const b = await request.get('/login');
    const csp = a.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).not.toContain("'unsafe-inline' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toBe(b.headers()['content-security-policy']);
    expect(a.headers()['x-content-type-options']).toBe('nosniff');
  });
});

test.describe('sign-out', () => {
  test('signing out ends the session', async ({ page, context }) => {
    // A fresh session (the stored per-role sessions are reused by other specs).
    await page.goto('/login');
    await page.getByLabel('Workspace').fill('demo');
    await page.getByLabel('Email').fill('counselor2@demo.test');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    const res = await context.request.get('/api/students');
    expect(res.status()).toBe(401);
  });
});
