import { describe, expect, it } from 'vitest';

import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  it('reports each dependency up/down without leaking details', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Storage and the scanner are the docker stack's MinIO and ClamAV (pnpm stack:up).
    expect(await res.json()).toEqual({
      status: 'ok',
      database: 'up',
      redis: 'not_configured',
      storage: 'up',
      scanner: 'up',
      worker: 'not_configured',
    });
  });
});
