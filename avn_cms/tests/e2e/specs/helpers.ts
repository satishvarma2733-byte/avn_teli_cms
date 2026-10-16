import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

import { STATE_DIR } from '../global-setup';

export const as = (role: 'admin' | 'counselor1' | 'counselor2' | 'telecaller1' | 'superadmin') => ({
  storageState: `${STATE_DIR}${role}.json`,
});

/** Fails on serious or critical WCAG 2.x A/AA violations. */
export async function expectAccessible(page: Page) {
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
