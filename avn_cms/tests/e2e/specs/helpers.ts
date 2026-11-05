import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { STATE_DIR } from '../global-setup';

export const as = (role: 'admin' | 'counselor1' | 'counselor2' | 'telecaller1' | 'superadmin') => ({
  storageState: `${STATE_DIR}${role}.json`,
});

/**
 * Presses "Sign in" on the sign-in page, as a person would, and waits for the answer. Every browser test
 * signs in from the same address, and the real limit is 10 sign-ins a minute per address. On a fast
 * machine the suite can reach it, so a 429 is waited out (the server's Retry-After) and the button pressed
 * again. Any other answer, right or wrong, is left to the test.
 */
export async function pressSignIn(page: Page) {
  for (let attempt = 1; ; attempt++) {
    const answer = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/login',
    );
    await page.getByRole('button', { name: 'Sign in' }).click();
    const res = await answer;
    if (res.status() !== 429 || attempt === 3) return;
    const waitSeconds = Number(res.headers()['retry-after'] ?? 60) + 1;
    test.info().setTimeout(test.info().timeout + waitSeconds * 1000);
    await page.waitForTimeout(waitSeconds * 1000);
  }
}

/** Fails on serious or critical WCAG 2.x A/AA violations. */
export async function expectAccessible(page: Page) {
  // The page title is streamed in after the body; check the page as a visitor sees it a moment later.
  await expect(page, 'the page has no <title>').toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) → ${v.nodes[0]?.target.join(' ')}`),
    'axe serious/critical violations',
  ).toEqual([]);
}

let phoneSeq = Math.floor(Math.random() * 9000);
/** A fresh fictional Indian mobile number for each created student. */
export function testPhone(): string {
  phoneSeq += 1;
  return `90008${String(10000 + (phoneSeq % 90000)).slice(-5)}`;
}

/**
 * On a phone a wide table must scroll inside its card; the page itself must not scroll sideways.
 * Resizes the window to a phone, so call it last in a test.
 */
export async function expectNoSidewaysScroll(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits, 'the page scrolls sideways at phone width').toBe(true);
}
