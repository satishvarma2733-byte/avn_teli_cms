import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createClient, type BaseClient } from './client';

/** Test-only helpers. Never imported by application code. */

const dbPackageDir = fileURLToPath(new URL('..', import.meta.url));

export function assertTestDatabase(url: string): void {
  if (!/\/[a-z0-9_]*_test(\?|$)/.test(url)) {
    throw new Error(
      `Refusing to reset a database whose name does not end in _test: ${url.replace(/:[^:@/]+@/, ':***@')}`,
    );
  }
}

/** Drops and recreates the public schema of the test database, then applies every migration. */
export async function resetTestDatabase(ownerUrl: string): Promise<void> {
  assertTestDatabase(ownerUrl);
  const owner = createClient(ownerUrl, { poolMax: 1 });
  try {
    await owner.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await owner.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await owner.$disconnect();
  }
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)), 'migrate', 'deploy'],
    {
      cwd: dbPackageDir,
      env: { ...process.env, DATABASE_OWNER_URL: ownerUrl },
      stdio: 'pipe',
    },
  );
}

/** Empties every table (keeps the schema). Faster than a full reset between test files. */
export async function truncateAll(owner: BaseClient): Promise<void> {
  const rows = await owner.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await owner.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
}

export { createClient };
