import { resetTestDatabase } from '@avn-cms/db/testing';

import { useTestDatabases } from './env';

/** Once per run: rebuild the test database from the migrations. */
export default async function setup(): Promise<void> {
  useTestDatabases();
  await resetTestDatabase(process.env['DATABASE_OWNER_URL']!);
}
