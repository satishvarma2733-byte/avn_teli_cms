/**
 * Prepares the documents bucket: creates it if it does not exist and sets the CORS rules the browser
 * needs to upload straight to it with a presigned URL.
 *
 *   pnpm storage:setup                      # allows the origin in APP_URL
 *   pnpm storage:setup --origin https://crm.example.com --origin https://staging.example.com
 *
 * On Cloudflare R2 this needs an API token with Admin Read & Write (an Object Read & Write token can
 * use the bucket but cannot create it or set CORS); the same can be done once in the Cloudflare
 * dashboard (R2 → the bucket → Settings → CORS policy, see docs/DOCUMENTS.md). Local MinIO sets its
 * CORS rules from MINIO_API_CORS_ALLOW_ORIGIN in docker-compose.yml and ignores this part.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(rootEnv) && process.env['NODE_ENV'] !== 'production') process.loadEnvFile(rootEnv);

const { getConfig } = await import('@avn-cms/config');
const { applyBucketCors, ensureBucket, objectStoreConfigured } = await import('@avn-cms/core');

if (!objectStoreConfigured()) {
  console.error('Document storage is not configured: set R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  console.error('and R2_ACCOUNT_ID (or R2_ENDPOINT for a local server). See docs/DOCUMENTS.md.');
  process.exit(2);
}

const origins = process.argv.flatMap((a, i) => (a === '--origin' ? [process.argv[i + 1]!] : []));
if (origins.length === 0) origins.push(new URL(getConfig().APP_URL).origin);

try {
  console.log(`Bucket ${await ensureBucket()}.`);
} catch (err) {
  console.error(`Could not create or reach the bucket: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
try {
  await applyBucketCors(origins);
  console.log(`CORS rules set for: ${origins.join(', ')}.`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`CORS rules were not set (${message}).`);
  console.warn('Set them in the storage provider instead (docs/DOCUMENTS.md → CORS).');
}
