import { documentsHealth, pingRedis, workerStatus } from '@avn-cms/core';
import { appDb, pingDatabase } from '@avn-cms/db';
import { NextResponse } from 'next/server';

/**
 * Liveness/readiness for load balancers and post-deploy smoke tests. Reports only up/down per
 * dependency — no versions, hostnames or counts.
 *
 * `status` (and the HTTP code) depends on the database and Redis only. Document storage, the
 * virus scanner and the background worker are reported as `storage`, `scanner` and `worker` but
 * never fail the check: the rest of the CRM works without documents, and a load balancer must not
 * pull every instance because R2, ClamAV or the worker is down (restarting web servers would not
 * bring any of them back). Alert on any of them being `down` separately (docs/RUNBOOK.md).
 */
export async function GET() {
  const [database, redis, documents, worker] = await Promise.all([
    pingDatabase(appDb()),
    pingRedis(),
    documentsHealth(),
    workerStatus(),
  ]);
  const ok = database && redis !== 'down';
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      database: database ? 'up' : 'down',
      redis,
      storage: documents.storage,
      scanner: documents.scanner,
      worker: worker.status,
    },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
