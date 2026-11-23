import { expect, test, type Page } from '@playwright/test';

import { as } from './helpers';

/**
 * Page-load budgets, measured in Chromium against the production build on this machine (so the network
 * is not the variable). They catch a regression such as a heavy dependency pulled into every page or a
 * layout that jumps as data arrives; they are not a substitute for a Lighthouse run on the real host.
 * Core Web Vitals "good" thresholds: LCP ≤ 2.5 s, CLS ≤ 0.1. Budgets below leave headroom for a slow CI runner.
 */
const BUDGET = {
  lcpMs: 2500,
  cls: 0.1,
  ttfbMs: 800,
  /** Scripts downloaded for the first view of any page, transferred (compressed) bytes. */
  scriptBytes: 450 * 1024,
};

interface Vitals {
  ttfb: number;
  fcp: number;
  lcp: number;
  cls: number;
  scriptBytes: number;
  scripts: number;
}

async function watchVitals(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __vitals: { lcp: number; cls: number } };
    w.__vitals = { lcp: 0, cls: 0 };
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      w.__vitals.lcp = entries[entries.length - 1]?.startTime ?? w.__vitals.lcp;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) w.__vitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

async function readVitals(page: Page): Promise<Vitals> {
  await page.waitForLoadState('networkidle');
  // Give late layout shifts and the final paint a moment to be reported.
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const w = window as unknown as { __vitals: { lcp: number; cls: number } };
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
    const scripts = performance
      .getEntriesByType('resource')
      .filter(
        (r) => (r as PerformanceResourceTiming).initiatorType === 'script',
      ) as PerformanceResourceTiming[];
    return {
      ttfb: nav.responseStart,
      fcp,
      lcp: w.__vitals.lcp,
      cls: w.__vitals.cls,
      scriptBytes: scripts.reduce((sum, r) => sum + r.transferSize, 0),
      scripts: scripts.length,
    };
  });
}

function report(path: string, v: Vitals) {
  const line = `${path}: TTFB ${v.ttfb.toFixed(0)} ms · FCP ${v.fcp.toFixed(0)} ms · LCP ${v.lcp.toFixed(0)} ms · CLS ${v.cls.toFixed(3)} · ${v.scripts} scripts, ${(v.scriptBytes / 1024).toFixed(0)} kB`;
  console.log(`[vitals] ${line}`);
  test.info().annotations.push({ type: 'vitals', description: line });
}

function expectWithinBudget(v: Vitals) {
  expect(v.lcp, 'largest contentful paint (ms)').toBeLessThanOrEqual(BUDGET.lcpMs);
  expect(v.cls, 'cumulative layout shift').toBeLessThanOrEqual(BUDGET.cls);
  expect(v.ttfb, 'time to first byte (ms)').toBeLessThanOrEqual(BUDGET.ttfbMs);
  expect(v.scriptBytes, 'script bytes transferred').toBeLessThanOrEqual(BUDGET.scriptBytes);
}

test.describe('signed-out page loads', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the sign-in page is fast and does not shift', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Largest Contentful Paint and Layout Shift are Chromium APIs');
    await watchVitals(page);
    await page.goto('/login');
    const vitals = await readVitals(page);
    report('/login', vitals);
    expectWithinBudget(vitals);
  });
});

test.describe('admin page loads', () => {
  test.use(as('admin'));

  for (const path of ['/app/dashboard', '/app/leads', '/app/followups', '/app/reports']) {
    test(`${path} is fast and does not shift`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'Largest Contentful Paint and Layout Shift are Chromium APIs');
      await watchVitals(page);
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeVisible();
      const vitals = await readVitals(page);
      report(path, vitals);
      expectWithinBudget(vitals);
    });
  }
});
