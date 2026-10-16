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

const envSchema = z.object({
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
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('aVn CMS <no-reply@avn-cms.local>'),
});

export type AppConfig = z.infer<typeof envSchema>;

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
