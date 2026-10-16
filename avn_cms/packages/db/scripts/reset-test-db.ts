import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resetTestDatabase } from '../src/testing';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const url = process.env['TEST_DATABASE_OWNER_URL'];
if (!url) throw new Error('TEST_DATABASE_OWNER_URL is not set');
await resetTestDatabase(url);
console.log('Test database reset and migrated.');
