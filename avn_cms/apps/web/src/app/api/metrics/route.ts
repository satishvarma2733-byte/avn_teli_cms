import { safeEqual } from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import { documentsHealth, pingRedis, queueDepth, rateLimit, workerStatus } from '@avn-cms/core';
import { appDb, pingDatabase } from '@avn-cms/db';
import { NextResponse, type NextRequest } from 'next/server';

import { clientIp } from '@/lib/api';
import { renderMetrics, type Gauge } from '@/lib/metrics';

/**
 * Prometheus scrape endpoint (docs/RUNBOOK.md "Monitoring"). Off unless METRICS_TOKEN is set; then it
 * needs `Authorization: Bearer <token>`. It reports counts and timings only: no tenant names, no ids, no
 * personal data. Request counters belong to the instance that answers, so scrape every instance.
 */
export async function GET(req: NextRequest) {
  const token = getConfig().METRICS_TOKEN;
  if (!token) return new NextResponse('Not found', { status: 404 });

  const limited = await rateLimit(`metrics:${clientIp(req)}`, 60, 60);
  if (!limited.allowed) return new NextResponse('Too many requests', { status: 429 });
  const given = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!safeEqual(given, token)) {
    return new NextResponse('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
  }

  const [database, redis, documents, worker, jobs] = await Promise.all([
    pingDatabase(appDb()),
    pingRedis(),
    documentsHealth(),
    workerStatus(),
    queueDepth(),
  ]);
  const up = (v: string | boolean) => (v === true || v === 'up' ? 1 : 0);
  const gauges: Gauge[] = [
    { name: 'avn_up', help: 'The app is running.', value: 1 },
    {
      name: 'avn_process_uptime_seconds',
      help: 'Seconds this instance has been running.',
      value: Math.round(process.uptime()),
    },
    {
      name: 'avn_process_resident_memory_bytes',
      help: 'Memory held by this instance.',
      value: process.memoryUsage().rss,
    },
    {
      name: 'avn_dependency_up',
      help: '1 when the dependency answers.',
      value: up(database),
      labels: { dependency: 'database' },
    },
    {
      name: 'avn_dependency_up',
      help: '1 when the dependency answers.',
      value: redis === 'not_configured' ? 1 : up(redis),
      labels: { dependency: 'redis' },
    },
    {
      name: 'avn_dependency_up',
      help: '1 when the dependency answers.',
      value: documents.storage === 'not_configured' ? 1 : up(documents.storage),
      labels: { dependency: 'storage' },
    },
    {
      name: 'avn_dependency_up',
      help: '1 when the dependency answers.',
      value: documents.scanner === 'not_configured' ? 1 : up(documents.scanner),
      labels: { dependency: 'scanner' },
    },
    {
      name: 'avn_dependency_up',
      help: '1 when the dependency answers.',
      value: worker.status === 'not_configured' ? 1 : up(worker.status),
      labels: { dependency: 'worker' },
    },
  ];
  if (worker.ageSeconds !== null) {
    gauges.push({
      name: 'avn_worker_heartbeat_age_seconds',
      help: 'Seconds since the worker last checked in.',
      value: worker.ageSeconds,
    });
  }
  if (jobs) {
    for (const [state, count] of Object.entries(jobs)) {
      gauges.push({ name: 'avn_jobs', help: 'Background jobs by state.', value: count, labels: { state } });
    }
  }
  return new NextResponse(renderMetrics(gauges), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
