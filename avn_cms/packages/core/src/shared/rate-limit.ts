import { getConfig } from '@avn-cms/config';
import { Redis } from 'ioredis';

/**
 * Fixed-window rate limiter on Redis (shared by every app instance). Without REDIS_URL
 * (unit tests) it falls back to an in-process map, which is only correct for one process.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const g = globalThis as unknown as {
  __avnRedis?: Redis | null;
  __avnMemLimits?: Map<string, { count: number; resetAt: number }>;
};

function redis(): Redis | null {
  if (g.__avnRedis !== undefined) return g.__avnRedis;
  const url = getConfig().REDIS_URL;
  g.__avnRedis = url
    ? new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false })
    : null;
  g.__avnRedis?.on('error', () => {
    /* surfaced through failed commands; avoid unhandled 'error' events */
  });
  return g.__avnRedis;
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const client = redis();
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const fullKey = `rl:${key}:${bucket}`;
  const retryAfterSeconds = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);

  if (client) {
    try {
      const count = await client.incr(fullKey);
      if (count === 1) await client.expire(fullKey, windowSeconds);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
    } catch {
      // Redis down: fail open for availability, but keep the in-memory limit as a floor.
    }
  }
  g.__avnMemLimits ??= new Map();
  const now = Date.now();
  const entry = g.__avnMemLimits.get(fullKey);
  if (!entry || entry.resetAt <= now) {
    g.__avnMemLimits.set(fullKey, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds };
  }
  entry.count += 1;
  return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), retryAfterSeconds };
}

/** Health probe for the shared Redis connection. */
export async function pingRedis(timeoutMs = 1500): Promise<'up' | 'down' | 'not_configured'> {
  const client = redis();
  if (!client) return 'not_configured';
  let timer: NodeJS.Timeout | undefined;
  try {
    const pong = await Promise.race([
      client.ping(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    return pong === 'PONG' ? 'up' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export async function closeRateLimiter(): Promise<void> {
  if (g.__avnRedis) await g.__avnRedis.quit().catch(() => undefined);
  g.__avnRedis = undefined;
}
