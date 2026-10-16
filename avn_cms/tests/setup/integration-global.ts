import { resetTestDatabase } from '@avn-cms/db/testing';

import { useTestDatabases } from './env';

/** Once per run: rebuild the test database from the migrations and make sure the test bucket exists. */
export default async function setup(): Promise<void> {
  useTestDatabases();
  await resetTestDatabase(process.env['DATABASE_OWNER_URL']!);
  // Documents use a local S3-compatible server (MinIO) in tests; its test bucket is created on demand.
  const { ensureBucket, objectStoreConfigured } = await import('@avn-cms/core');
  if (objectStoreConfigured()) await ensureBucket();
}
