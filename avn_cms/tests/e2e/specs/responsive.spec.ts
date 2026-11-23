import { expect, test, type Page } from '@playwright/test';

import { as, expectAccessible } from './helpers';

/**
 * Every screen, at phone and tablet width: the page never scrolls sideways, the navigation is
 * reachable from the menu button, and nothing serious or critical fails an accessibility check.
 * (Wide tables scroll inside their own card; see `expectNoSidewaysScroll` in helpers.)
 */
const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

const ADMIN_PAGES = [
  '/app/dashboard',
  '/app/leads',
  '/app/leads/new',
  '/app/followups',
  '/app/web-leads',
  '/app/reports',
  '/app/imports',
  '/app/imports/new',
  '/app/exports',
  '/app/documents',
  '/app/automations',
  '/app/notifications',
  '/app/users',
  '/app/audit',
  '/app/settings',
  '/app/settings/integrations',
  '/app/account',
] as const;

/** Names the elements that stick out past the right edge, so a failure says what to fix. */
async function overflowReport(page: Page): Promise<string> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > width + 1)
      .slice(0, 5)
      .map((el) => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 80)}">`);
    return `page is ${document.documentElement.scrollWidth}px wide in a ${width}px window; first culprits: ${wide.join(' ')}`;
  });
}

async function expectFits(page: Page) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits, fits ? '' : await overflowReport(page)).toBe(true);
}

async function settle(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible();
  // Lists and charts fill in after the first paint; check the finished page, not the skeleton.
  await page.waitForLoadState('networkidle');
}

for (const size of SIZES) {
  test.describe(`admin at ${size.name} width (${size.width}px)`, () => {
    test.use({ ...as('admin'), viewport: { width: size.width, height: size.height } });

    for (const path of ADMIN_PAGES) {
      test(`${path} fits, is accessible, and the menu reaches it`, async ({ page }) => {
        await page.goto(path);
        await settle(page);
        await expectFits(page);
        await expectAccessible(page);

        // Below the desktop breakpoint the sidebar is behind the menu button.
        await page.getByRole('button', { name: 'Open menu' }).click();
        const menu = page.getByRole('dialog', { name: 'Navigation' });
        await expect(menu.getByRole('link', { name: 'Dashboard' })).toBeVisible();
        await menu.getByRole('button', { name: 'Close menu' }).click();
        await expect(menu).toHaveCount(0);
      });
    }

    test('a lead’s page fits and is accessible', async ({ page }) => {
      await page.goto('/app/leads');
      await settle(page);
      const lead = page.locator('main a[href^="/app/leads/"]:not([href$="/new"])').first();
      await expect(lead).toBeVisible();
      await lead.click();
      await expect(page).toHaveURL(/\/app\/leads\/[0-9a-f-]{36}/);
      await settle(page);
      await expectFits(page);
      await expectAccessible(page);
    });
  });
}

test.describe('platform console at phone width', () => {
  test.use({ ...as('superadmin'), viewport: { width: 390, height: 844 } });

  test('/platform fits and is accessible', async ({ page }) => {
    await page.goto('/platform');
    await settle(page);
    await expectFits(page);
    await expectAccessible(page);
  });
});

test.describe('signed-out pages', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const size of SIZES) {
    for (const path of ['/login', '/forgot-password', '/does-not-exist']) {
      test(`${path} at ${size.name} width fits and is accessible`, async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(path);
        await settle(page);
        await expectFits(page);
        await expectAccessible(page);
      });
    }
  }
});
