// Runs a command against the load-test database: `node with-load-env.mjs pnpm --filter @avn-cms/db migrate:deploy`.
import { spawnSync } from 'node:child_process';

const owner =
  process.env.LOAD_DATABASE_OWNER_URL ??
  'postgresql://avn_owner:avn_owner_local_only@127.0.0.1:55460/avn_cms_load';
const [command, ...args] = process.argv.slice(2);
const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DATABASE_OWNER_URL: owner },
});
process.exit(result.status ?? 1);
