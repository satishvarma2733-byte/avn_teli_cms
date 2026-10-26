import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cached, clearCacheForTests } from './cache';

/** The answer cache for dashboards and reports (no Redis in unit tests: the in-process copy). */
describe('cached', () => {
  const T0 = 1_000_000;
  let calls: number;
  const compute =
    (value: unknown = 'answer') =>
    async () => {
      calls += 1;
      return { value, n: calls };
    };

  beforeEach(() => {
    clearCacheForTests();
    calls = 0;
  });

  it('computes every time when switched off (0 seconds)', async () => {
    await cached('k', compute(), 0, T0);
    await cached('k', compute(), 0, T0);
    expect(calls).toBe(2);
  });

  it('reuses an answer while it is fresh', async () => {
    const first = await cached('k', compute(), 60, T0);
    const second = await cached('k', compute(), 60, T0 + 59_000);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it('keeps answers for different keys apart', async () => {
    const a = await cached('tenant-a:dash', compute('a'), 60, T0);
    const b = await cached('tenant-b:dash', compute('b'), 60, T0);
    expect(a.value).toBe('a');
    expect(b.value).toBe('b');
    expect(calls).toBe(2);
  });

  it('serves the old answer at once after it expires, and brings it up to date for the next person', async () => {
    const first = await cached('k', compute(), 60, Date.now());
    // Pretend the stored answer was computed two minutes ago.
    const stale = await cached('k', compute(), 1, Date.now() + 2_000);
    expect(stale).toEqual(first); // not recomputed for this caller
    await vi.waitFor(() => expect(calls).toBe(2)); // recomputed in the background
    const next = await cached('k', compute(), 60, Date.now());
    expect(next.n).toBe(2);
  });

  it('recomputes in the foreground once an answer is too old to serve', async () => {
    await cached('k', compute(), 1, Date.now());
    const fresh = await cached('k', compute(), 1, Date.now() + 11_000);
    expect(fresh.n).toBe(2);
  });

  it('runs one computation at a time per key, however many people ask together', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = async () => {
      calls += 1;
      await gate;
      return 'done';
    };
    const asked = [cached('k', slow, 60), cached('k', slow, 60), cached('k', slow, 60)];
    release();
    expect(await Promise.all(asked)).toEqual(['done', 'done', 'done']);
    expect(calls).toBe(1);
  });

  it('does not keep a failed computation: the next caller tries again', async () => {
    await expect(
      cached(
        'k',
        async () => {
          throw new Error('database busy');
        },
        60,
      ),
    ).rejects.toThrow('database busy');
    const ok = await cached('k', compute(), 60);
    expect(ok.n).toBe(1);
  });
});
