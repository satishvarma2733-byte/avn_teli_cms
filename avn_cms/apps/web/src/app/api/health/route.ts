import { documentsHealth, pingRedis } from '@avn-cms/core';
import { appDb, pingDatabase } from '@avn-cms/db';
import { NextResponse } from 'next/server';

/**
 * Liveness/readiness for load balancers and post-deploy smoke tests. Reports only up/down per
 * dependency — no versions, hostnames or counts.
 *
 * `status` (and the HTTP code) depends on the database and Redis only. Document storage and the
 * virus scanner are reported as `storage` and `scanner` but never fail the check: the rest of the
 * CRM works without documents, and a load balancer must not pull every instance because R2 or
 * ClamAV is down. Alert on `storage` or `scanner` being `down` separately.
 */
export async function GET() {
  const [database, redis, documents] = await Promise.all([
    pingDatabase(appDb()),
    pingRedis(),
    documentsHealth(),
  ]);
  const ok = database && redis !== 'down';
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      database: database ? 'up' : 'down',
      redis,
      storage: documents.storage,
      scanner: documents.scanner,
    },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
