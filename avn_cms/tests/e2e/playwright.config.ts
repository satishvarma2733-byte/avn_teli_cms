import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end: the production build (`next start`) against the *_test database, freshly
 * migrated and seeded with TEST DATA in global setup. Run `pnpm build` first (test:e2e does).
 */
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export const E2E_PORT = 3301;
export const E2E_URL = `http://localhost:${E2E_PORT}`;

const serverEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  NODE_ENV: 'production',
  APP_URL: E2E_URL,
  DATABASE_URL: process.env['TEST_DATABASE_URL']!,
  DATABASE_OWNER_URL: process.env['TEST_DATABASE_OWNER_URL']!,
  // No email in e2e: flows must show the honest "not sent" path (invite link shown to the admin).
  // Empty values (not deleted keys) so the root .env loaded by next.config.ts cannot refill them.
  SMTP_HOST: '',
  SMTP_PORT: '',
  // Per-process rate limits (no shared Redis state between runs).
  REDIS_URL: '',
};

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
  outputDir: '../../test-results',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: E2E_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
  ],
  webServer: {
    command: `pnpm exec next start -p ${E2E_PORT}`,
    cwd: fileURLToPath(new URL('../../apps/web', import.meta.url)),
    url: `${E2E_URL}/login`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: serverEnv,
  },
});
