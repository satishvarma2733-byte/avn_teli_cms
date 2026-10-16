import { describe, expect, it } from 'vitest';

import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  it('reports the database up and Redis as not configured in tests, without leaking details', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', database: 'up', redis: 'not_configured' });
  });
});
