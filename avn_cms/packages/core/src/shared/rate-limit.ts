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

/** The one Redis connection of this process, shared with the answer cache (null without REDIS_URL). */
export function sharedRedis(): Redis | null {
  return redis();
}

/**
 * The shared connection once it can take commands. The client fails commands at once rather than queueing them
 * (so a dead Redis never stalls a request), which also means a client created a moment ago cannot yet take one:
 * the first request after a start would have found Redis "down" (and the first health check said so). While the
 * first connection is being made we wait for it, at most `timeoutMs`; after a connection has been lost we do not
 * wait at all. Null when there is no Redis or it is not usable right now.
 */
export async function readyRedis(timeoutMs = 300): Promise<Redis | null> {
  const client = redis();
  if (!client) return null;
  if (client.status === 'ready') return client;
  if (!['wait', 'connecting', 'connect'].includes(client.status)) return null;
  return new Promise<Redis | null>((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(ok ? client : null);
    };
    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.once('ready', onReady);
  });
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const client = await readyRedis();
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const fullKey = `rl:${key}:${bucket}`;
  const retryAfterSeconds = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);

  if (client) {
    try {
      // Count and expiry in one round trip, so a crash between them can't leave a counter that never
      // expires. (The window number is part of the key, so re-setting the expiry is harmless.)
      const replies = await client
        .multi()
        .incr(fullKey)
        .expire(fullKey, windowSeconds + 1)
        .exec();
      const first = replies?.[0];
      if (!first || first[0]) throw first?.[0] ?? new Error('no reply');
      const count = Number(first[1]);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
    } catch {
      // Redis down: fail open for availability, but keep the in-memory limit as a floor.
    }
  }
  g.__avnMemLimits ??= new Map();
  const now = Date.now();
  if (g.__avnMemLimits.size > 10_000) {
    // No Redis: forget windows that have ended, so the map cannot grow without bound.
    for (const [k, v] of g.__avnMemLimits) if (v.resetAt <= now) g.__avnMemLimits.delete(k);
  }
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
  if (!redis()) return 'not_configured';
  const client = await readyRedis(timeoutMs);
  if (!client) return 'down';
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
