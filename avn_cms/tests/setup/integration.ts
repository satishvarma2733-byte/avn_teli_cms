import { afterAll } from 'vitest';

import { useTestDatabases } from './env';

useTestDatabases();

afterAll(async () => {
  const { disconnectAll } = await import('@avn-cms/db');
  await disconnectAll();
});
