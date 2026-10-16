import { expect, test } from '@playwright/test';

import { as, expectAccessible, testPhone } from './helpers';

test.use(as('admin'));

test('lead journey: create → duplicate caught → search → stage → assign → schedule → log call', async ({
  page,
}) => {
  const phone = testPhone();
  const name = `E2E Student ${phone.slice(-4)}`;

  // Create
  await page.goto('/app/leads/new');
  await expectAccessible(page);
  await page.getByLabel('Student name').fill(name);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByLabel('Source').selectOption({ label: 'Website' });
  await page.getByLabel('Country of interest').selectOption('Georgia');
  await page.getByLabel('Counselor').selectOption({ label: 'Chaitanya Counselor' });
  await page.getByRole('button', { name: 'Save student' }).click();
  await expect(page).toHaveURL(/\/app\/leads\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const leadUrl = page.url();

  // Duplicate phone is caught before saving
  await page.goto('/app/leads/new');
  await page.getByLabel('Student name').fill('Someone else');
  await page.getByLabel('Mobile number').fill(`+91 ${phone.slice(0, 5)} ${phone.slice(5)}`);
  await page.getByLabel('Source').selectOption({ label: 'Website' });
  await page.getByRole('button', { name: 'Save student' }).click();
  await expect(page.getByText('This student is already in aVn CMS')).toBeVisible();
  await page.getByRole('link', { name: 'Open the existing lead' }).click();
  await expect(page).toHaveURL(leadUrl);

  // Search in the workspace
  await page.goto('/app/leads');
  await page.getByLabel('Search leads').fill(phone.slice(-6));
  await expect(page.getByRole('link', { name })).toBeVisible();
  await expectAccessible(page);

  // Stage change with history
  await page.goto(leadUrl);
  await page.getByRole('button', { name: 'Change stage' }).click();
  await page.getByRole('dialog').getByLabel('Stage').selectOption('INTERESTED');
  await page.getByRole('dialog').getByLabel('Note').fill('Wants Georgia fees');
  await page.getByRole('button', { name: 'Save stage' }).click();
  await expect(page.getByText('Stage updated.')).toBeVisible();
  await page.getByRole('tab', { name: 'Stage history' }).click();
  await expect(page.getByText('Wants Georgia fees')).toBeVisible();

  // Assign a telecaller
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByLabel('Telecaller', { exact: true }).selectOption({ label: 'Teja Telecaller' });
  await expect(page.getByText('Telecaller updated.')).toBeVisible();

  // Schedule and log a call
  await page.getByRole('button', { name: 'Schedule call' }).click();
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText('Call scheduled.')).toBeVisible();
  await expect(page.getByText(/Next call/)).toBeVisible();
  await page.getByRole('button', { name: 'Log call outcome' }).click();
  await page.getByRole('dialog').getByLabel('What happened?').selectOption('CALL_BACK_LATER');
  await page.getByRole('dialog').getByLabel('Call notes').fill('Asked to call after results');
  await page.getByRole('button', { name: 'Save outcome' }).click();
  await expect(page.getByText('Call outcome saved.')).toBeVisible();
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('Call: Call back later — Asked to call after results')).toBeVisible();
  await expect(page.getByText(/Stage changed from Interested to Follow-up required/)).toBeVisible();
  await expectAccessible(page);
});

test('dashboard, follow-ups and reports render from real data', async ({ page }) => {
  await page.goto('/app/dashboard');
  await expect(page.getByText('Total active leads')).toBeVisible();
  await expectAccessible(page);
  await page.goto('/app/followups');
  await expect(page.getByRole('tab', { name: /Today/ })).toBeVisible();
  await expectAccessible(page);
  await page.goto('/app/reports');
  await expect(page.getByRole('heading', { name: 'Conversion funnel' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team performance' })).toBeVisible();
  await expectAccessible(page);
});
