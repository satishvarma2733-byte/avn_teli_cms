import { expect, test } from '@playwright/test';

import { as } from './helpers';

test.describe('telecaller', () => {
  test.use(as('telecaller1'));
  test('cannot open admin pages and gets no admin navigation', async ({ page }) => {
    await page.goto('/app/users');
    await expect(page).toHaveURL(/\/app\/dashboard$/);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Users' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  });

  test('the API refuses admin actions', async ({ page }) => {
    await page.goto('/app/dashboard');
    const res = await page.request.get('/api/users');
    expect(res.status()).toBe(403);
  });
});

test.describe('counselor', () => {
  test.use(as('counselor1'));
  test('sees only their own leads and gets 404 for a colleague’s lead', async ({ page, browser }) => {
    // Find a lead owned by counselor2 using counselor2's session.
    const other = await browser.newContext(as('counselor2'));
    const theirs = await (await other.request.get('/api/students?limit=1')).json();
    const theirLeadId = theirs.data[0].id as string;
    await other.close();

    const mine = await (await page.request.get('/api/students?limit=100')).json();
    expect(
      mine.data.every(
        (r: { counselor: { name: string } | null }) => r.counselor?.name === 'Chaitanya Counselor',
      ),
    ).toBe(true);
    expect(mine.data.some((r: { id: string }) => r.id === theirLeadId)).toBe(false);

    const res = await page.request.get(`/api/leads/${theirLeadId}`);
    expect(res.status()).toBe(404);
    await page.goto(`/app/leads/${theirLeadId}`);
    await expect(
      page.getByText('We couldn’t find that page').or(page.getByText("We couldn't find that page")),
    ).toBeVisible();
  });

  test('mutations without the CSRF token are refused', async ({ page }) => {
    await page.goto('/app/dashboard');
    const res = await page.request.post('/api/students', {
      data: { name: 'x', phone: '9876543210', sourceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.status()).toBe(403);
  });
});
