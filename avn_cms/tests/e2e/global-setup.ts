import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { request, type FullConfig } from '@playwright/test';

import { resetTestDatabase } from '../../packages/db/src/testing';

export const STATE_DIR = fileURLToPath(new URL('../../test-results/.auth/', import.meta.url));
export const E2E_PASSWORD = 'E2e-Password-2026';

export const ACCOUNTS = {
  admin: { workspace: 'demo', email: 'admin@demo.test' },
  counselor1: { workspace: 'demo', email: 'counselor1@demo.test' },
  counselor2: { workspace: 'demo', email: 'counselor2@demo.test' },
  telecaller1: { workspace: 'demo', email: 'telecaller1@demo.test' },
  superadmin: { workspace: '', email: 'superadmin@avn-cms.test' },
} as const;

/** Fresh test database + demo seed, then one signed-in browser state per role. */
export default async function globalSetup(config: FullConfig) {
  const ownerUrl = process.env['TEST_DATABASE_OWNER_URL'];
  if (!ownerUrl) throw new Error('TEST_DATABASE_OWNER_URL is not set');
  await resetTestDatabase(ownerUrl);
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)), 'prisma/seed.ts'],
    {
      cwd: fileURLToPath(new URL('../../packages/db', import.meta.url)),
      env: {
        ...process.env,
        SEED_DATABASE_OWNER_URL: ownerUrl,
        SEED_PASSWORD: E2E_PASSWORD,
        NODE_ENV: 'development',
      },
      stdio: 'inherit',
    },
  );

  mkdirSync(STATE_DIR, { recursive: true });
  const baseURL = config.projects[0]!.use.baseURL!;
  for (const [name, acct] of Object.entries(ACCOUNTS)) {
    const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
    const res = await ctx.post('/api/auth/login', { data: { ...acct, password: E2E_PASSWORD } });
    if (!res.ok()) throw new Error(`login failed for ${name}: ${res.status()} ${await res.text()}`);
    await ctx.storageState({ path: `${STATE_DIR}${name}.json` });
    await ctx.dispose();
  }
}
