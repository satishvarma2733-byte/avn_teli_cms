import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Points the app at the *_test databases. Shared by global setup and per-file setup. */
export function useTestDatabases(): void {
  const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const app = process.env['TEST_DATABASE_URL'];
  const owner = process.env['TEST_DATABASE_OWNER_URL'];
  if (!app || !owner)
    throw new Error('TEST_DATABASE_URL and TEST_DATABASE_OWNER_URL must be set (see .env.example)');
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = app;
  process.env['DATABASE_OWNER_URL'] = owner;
  // Rate limits use the in-process fallback in tests so runs don't share Redis state.
  delete process.env['REDIS_URL'];
  // Test requests carry one X-Forwarded-For address each, as if one proxy sat in front of the app.
  process.env['TRUSTED_PROXY_HOPS'] = '1';
  // Two-step verification is optional unless a test asks for it.
  delete process.env['MFA_REQUIRED_ROLES'];
  // Tests never send email (the "not configured" path is what they exercise).
  delete process.env['SMTP_HOST'];
  delete process.env['SMTP_PORT'];
  // Documents use their own bucket in tests, never the development one.
  if (process.env['TEST_R2_BUCKET']) process.env['R2_BUCKET'] = process.env['TEST_R2_BUCKET'];
}
