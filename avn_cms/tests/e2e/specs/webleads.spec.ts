import { expect, test } from '@playwright/test';

import { as, expectAccessible, testPhone } from './helpers';

test.use(as('admin'));

test('website intake: create credential → LeadXP-format POST → inbox → convert', async ({
  page,
  request,
}) => {
  await page.goto('/app/settings/integrations');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'New credential' }).click();
  await page.getByLabel('Name').fill('E2E landing page');
  await page.getByRole('button', { name: 'Create' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Credential created')).toBeVisible();
  // The header is shown once; read it from the page like an admin copying it.
  const header = (await dialog.locator('code').nth(2).textContent())!.trim();
  expect(header).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
  await page.getByRole('button', { name: 'I have saved it' }).click();

  const phone = testPhone();
  const res = await request.post('/api/webleads', {
    headers: { Authorization: header, 'Content-Type': 'application/json' },
    data: {
      name: 'E2E Web Enquiry',
      mobile: phone,
      email: 'web@example.test',
      message: 'Fees for Kyrgyzstan please',
      neet_score: 480,
      preferred_country: 'Kyrgyzstan',
      google_click_id: null,
      campaign_id: null,
      source: 'Landing Page',
    },
  });
  expect(res.status()).toBe(201);
  expect(await res.json()).toMatchObject({ success: true, status: 'NEW' });
  const bad = await request.post('/api/webleads', {
    headers: { Authorization: 'Basic d2xfeDp5' },
    data: { name: 'x', mobile: phone },
  });
  expect(bad.status()).toBe(401);

  await page.goto('/app/web-leads');
  await expect(page.getByText('E2E Web Enquiry')).toBeVisible();
  await expect(page.getByText('NEET 480')).toBeVisible();
  await expectAccessible(page);
  const row = page.getByRole('listitem').filter({ hasText: 'E2E Web Enquiry' });
  await row.getByRole('button', { name: 'Convert' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Convert' }).click();
  await expect(page.getByText('Converted to a new lead.')).toBeVisible();
  await page.getByRole('link', { name: 'Open lead' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E Web Enquiry');
  await page.getByRole('tab', { name: /Notes/ }).click();
  await expect(page.getByText('Enquiry message: Fees for Kyrgyzstan please')).toBeVisible();
});
