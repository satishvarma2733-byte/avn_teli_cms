import { getConfig } from '@avn-cms/config';

import { readyRedis } from './rate-limit';

/**
 * A short-lived cache for answers that are expensive to compute and fine to be a little old: the
 * dashboard and the reports of a workspace with hundreds of thousands of leads (docs/SCALABILITY.md).
 *
 * - **Fresh for `REPORT_CACHE_SECONDS`** (default 60; 0 turns caching off, which is what the tests do).
 * - **Stale-while-revalidate:** after that, for ten times as long, the old answer is returned at once and a
 *   new one is computed in the background, so nobody waits for a recompute after the first one.
 * - **One computation at a time** per key in a process, however many people ask at once.
 * - Shared between app instances through Redis; without Redis each instance keeps its own (small) copy.
 *
 * Keys name the workspace and the person's scope, so one workspace's or one person's answer can never be
 * served to another. Values must be plain JSON (no Dates, no BigInt): they round-trip through Redis.
 */

interface Entry<T> {
  value: T;
  computedAt: number;
}

const STALE_FACTOR = 10;
/**
 * Part of every Redis key. Change it when the shape of a cached answer changes, so a new release never reads an
 * old release's answers (they live up to ten minutes in Redis, across a deploy).
 */
const CACHE_VERSION = 'v1';
const MAX_LOCAL_ENTRIES = 500;
const local = new Map<string, Entry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export function reportCacheSeconds(): number {
  return getConfig().REPORT_CACHE_SECONDS;
}

async function read<T>(key: string): Promise<Entry<T> | null> {
  const client = await readyRedis();
  if (client) {
    try {
      const raw = await client.get(`cache:${CACHE_VERSION}:${key}`);
      if (raw) return JSON.parse(raw) as Entry<T>;
      return null;
    } catch {
      /* Redis unreachable: fall back to this process's copy */
    }
  }
  return (local.get(key) as Entry<T> | undefined) ?? null;
}

async function write<T>(key: string, entry: Entry<T>, ttlSeconds: number): Promise<void> {
  const client = await readyRedis();
  if (client) {
    try {
      await client.set(
        `cache:${CACHE_VERSION}:${key}`,
        JSON.stringify(entry),
        'EX',
        ttlSeconds * STALE_FACTOR,
      );
      return;
    } catch {
      /* fall through to the local copy */
    }
  }
  if (local.size >= MAX_LOCAL_ENTRIES) local.delete(local.keys().next().value!);
  local.set(key, entry);
}

/** Computes once at a time per key; everyone asking meanwhile shares the answer. */
function singleFlight<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const started = compute().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

export async function cached<T>(
  key: string,
  compute: () => Promise<T>,
  ttlSeconds = reportCacheSeconds(),
  now = Date.now(),
): Promise<T> {
  if (ttlSeconds <= 0) return compute();
  const refresh = () =>
    singleFlight(key, async () => {
      const value = await compute();
      await write(key, { value, computedAt: Date.now() }, ttlSeconds);
      return value;
    });
  const hit = await read<T>(key);
  if (!hit) return refresh();
  const age = now - hit.computedAt;
  if (age < ttlSeconds * 1000) return hit.value;
  if (age < ttlSeconds * 1000 * STALE_FACTOR) {
    // Old but usable: answer now, bring it up to date for the next person.
    void refresh().catch((err: unknown) =>
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'background refresh of a cached answer failed',
          key: key.split(':').slice(0, 2).join(':'),
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
    return hit.value;
  }
  return refresh();
}

/** For tests: forget everything this process cached. */
export function clearCacheForTests(): void {
  local.clear();
  inFlight.clear();
}
