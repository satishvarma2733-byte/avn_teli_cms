import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, env } from 'prisma/config';

// Prisma 7 does not load .env itself. Locally the workspace-root .env is loaded; in CI and
// production the variables come from the environment.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Migrations always run as the owner role (the app role cannot create tables or policies).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_OWNER_URL') },
});
