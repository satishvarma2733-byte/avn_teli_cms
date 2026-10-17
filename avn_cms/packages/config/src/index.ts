import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/**
 * The one place that reads process.env (MODULE_STRUCTURE conventions). Everything else
 * receives a validated, typed config object.
 */
const secret = z
  .string()
  .min(1, 'is required')
  .refine((v) => Buffer.from(v, 'base64').length >= 32, 'must be at least 32 random bytes, base64');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.url().default('http://localhost:3300'),
    DATABASE_URL: z.string().startsWith('postgres'),
    DATABASE_OWNER_URL: z.string().startsWith('postgres'),
    REDIS_URL: z.string().startsWith('redis').optional(),
    SESSION_SECRET: secret,
    ENCRYPTION_KEY: secret,
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(168),
    // How many proxies in front of the app set X-Forwarded-For (a load balancer or CDN = 1). 0 ignores
    // the header, so a caller cannot choose the address that rate limits and the audit log see.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    // Roles that must turn on two-step verification before they can use the app (comma separated,
    // for example "SUPER_ADMIN,TENANT_ADMIN"). Empty: it stays optional for everyone.
    MFA_REQUIRED_ROLES: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((r) => r.trim().toUpperCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(['SUPER_ADMIN', 'TENANT_ADMIN', 'COUNSELOR', 'TELECALLER']))),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().default('aVn CMS <no-reply@avn-cms.local>'),
    // Document storage: Cloudflare R2 through its S3 API. Set the bucket, the key pair and either the
    // account id or an endpoint, all together. Unset, the documents vault says storage is not set up.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    // Overrides https://<account>.r2.cloudflarestorage.com (local MinIO, or any S3-compatible server).
    R2_ENDPOINT: z.url().optional(),
    // Antivirus (clamd). Without it uploaded documents stay unavailable: nothing is served unscanned.
    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  })
  .superRefine((env, ctx) => {
    // Half-set storage settings would silently disable documents; say so instead.
    const needed = ['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;
    const anySet = needed.some((k) => env[k]) || env.R2_ACCOUNT_ID || env.R2_ENDPOINT;
    if (!anySet) return;
    for (const key of needed) {
      if (!env[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required when document storage is configured',
        });
    }
    if (!env.R2_ACCOUNT_ID && !env.R2_ENDPOINT) {
      ctx.addIssue({ code: 'custom', path: ['R2_ACCOUNT_ID'], message: 'is required (or set R2_ENDPOINT)' });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export interface ObjectStorageConfig {
  endpoint: string;
  region: 'auto';
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The R2 settings when every needed value is present, otherwise null (documents unavailable). */
export function objectStorageConfig(config: AppConfig): ObjectStorageConfig | null {
  const { R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_ENDPOINT } = config;
  if (!R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  const endpoint =
    R2_ENDPOINT ?? (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);
  if (!endpoint) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    region: 'auto',
    bucket: R2_BUCKET,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  };
}

let cached: AppConfig | undefined;

/** Finds the workspace root .env (walking up from cwd) and loads it once, if present. */
function loadDotEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const file = join(dir, '.env');
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      if (existsSync(file)) process.loadEnvFile(file);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  // Production and tests take the environment as given (the test setup prepares it explicitly).
  if (process.env['NODE_ENV'] !== 'production' && process.env['NODE_ENV'] !== 'test') loadDotEnv();
  // An empty variable means "not set" (so `SMTP_HOST=` disables email instead of failing validation).
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests: forget the cached config so a changed environment is re-read. */
export function resetConfigForTests(): void {
  cached = undefined;
}

export const isProduction = (): boolean => getConfig().NODE_ENV === 'production';
