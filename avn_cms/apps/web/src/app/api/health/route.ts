import { pingRedis } from '@avn-cms/core';
import { appDb, pingDatabase } from '@avn-cms/db';
import { NextResponse } from 'next/server';

/**
 * Liveness/readiness for load balancers and post-deploy smoke tests. Reports only up/down per
 * dependency — no versions, hostnames or counts.
 */
export async function GET() {
  const [database, redis] = await Promise.all([pingDatabase(appDb()), pingRedis()]);
  const ok = database && redis !== 'down';
  return NextResponse.json(
    { status: ok ? 'ok' : 'degraded', database: database ? 'up' : 'down', redis },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
