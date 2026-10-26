import { resetConfigForTests } from '@avn-cms/config';
import {
  WORKER_HEARTBEAT_KEY,
  clearCacheForTests,
  closeQueue,
  closeRateLimiter,
  reports,
  workerStatus,
  writeWorkerHeartbeat,
} from '@avn-cms/core';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as health } from '@/app/api/health/route';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';
import { call, signIn } from './helpers/http';

/**
 * What an operator relies on (docs/RUNBOOK.md): the health check and metrics endpoint, the worker's
 * heartbeat, request ids, and the report cache against a real Redis (so cached answers survive
 * the JSON round trip and are shared between web instances).
 *
 * Needs the docker Redis (`pnpm stack:up`); uses database 15, like the job-queue test.
 */
const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:16390/15';
const TOKEN = 'metrics-token-for-tests-0123456789';

describe('operations', () => {
  let redis: Redis;

  beforeAll(async () => {
    if (!/\/[1-9]\d*$/.test(REDIS_URL))
      throw new Error(`TEST_REDIS_URL must name a Redis database other than 0 (got ${REDIS_URL}).`);
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      await redis.ping();
    } catch (cause) {
      throw new Error(`Redis is not reachable at ${REDIS_URL}. Start it with "pnpm stack:up".`, { cause });
    }
  });

  afterAll(async () => {
    await redis?.flushdb().catch(() => undefined);
    await redis?.quit().catch(() => undefined);
  });

  const useRedis = async (on: boolean) => {
    await closeQueue();
    await closeRateLimiter();
    if (on) process.env['REDIS_URL'] = REDIS_URL;
    else delete process.env['REDIS_URL'];
    resetConfigForTests();
    clearCacheForTests();
  };

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterEach(async () => {
    delete process.env['METRICS_TOKEN'];
    process.env['REPORT_CACHE_SECONDS'] = '0';
    await useRedis(false);
  });

  describe('the worker heartbeat', () => {
    it('is up while the worker keeps checking in, and down once it stops', async () => {
      await useRedis(true);
      expect(await workerStatus()).toEqual({ status: 'down', ageSeconds: null }); // never started
      await writeWorkerHeartbeat(redis, Date.now() - 60_000);
      const up = await workerStatus();
      expect(up.status).toBe('up');
      expect(up.ageSeconds).toBeLessThan(5);

      // A heartbeat from two minutes ago is a worker that has stopped.
      await redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: Date.now() - 120_000 }), 'EX', 300);
      const stale = await workerStatus();
      expect(stale.status).toBe('down');
      expect(stale.ageSeconds).toBeGreaterThanOrEqual(119);
    });

    it('shows in /api/health without changing its status code', async () => {
      await useRedis(true);
      let res = await health();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok', redis: 'up', worker: 'down' });
      await writeWorkerHeartbeat(redis, Date.now());
      res = await health();
      expect(await res.json()).toMatchObject({ status: 'ok', redis: 'up', worker: 'up' });
    });
  });

  describe('GET /api/metrics', () => {
    const scrape = (token?: string) =>
      call('metrics', 'GET', {
        caller: null,
        origin: null,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    it('does not exist until a token is configured', async () => {
      expect((await scrape()).status).toBe(404);
      expect((await scrape(TOKEN)).status).toBe(404);
    });

    it('wants the token, and says nothing about why a wrong one failed', async () => {
      process.env['METRICS_TOKEN'] = TOKEN;
      resetConfigForTests();
      const none = await scrape();
      expect(none.status).toBe(401);
      expect(none.headers.get('www-authenticate')).toBe('Bearer');
      expect((await scrape('not-the-token-0123456789012')).status).toBe(401);
      expect(String(none.body)).not.toContain(TOKEN);
    });

    it('reports dependency state, jobs and request counts as Prometheus text, with no personal data', async () => {
      await useRedis(true);
      process.env['METRICS_TOKEN'] = TOKEN;
      resetConfigForTests();
      await resetData();
      const tenant = await makeTenant('metrics-co');
      await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@metrics-co.test');
      const admin = await signIn('metrics-co', 'admin@metrics-co.test');
      await writeWorkerHeartbeat(redis, Date.now());
      await call('students', 'GET', { caller: admin });
      await call('students', 'GET', { caller: admin });

      const res = await scrape(TOKEN);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = String(res.body);
      expect(text).toContain('avn_up 1');
      expect(text).toContain('avn_dependency_up{dependency="database"} 1');
      expect(text).toContain('avn_dependency_up{dependency="redis"} 1');
      expect(text).toContain('avn_dependency_up{dependency="worker"} 1');
      expect(text).toMatch(/avn_worker_heartbeat_age_seconds [0-4]\b/);
      expect(text).toMatch(/avn_jobs\{state="waiting"\} \d+/);
      expect(text).toMatch(
        /avn_http_requests_total\{method="GET",resource="\/api\/students",status="2xx"\} [2-9]/,
      );
      expect(text).toContain('avn_http_request_duration_seconds_bucket');
      // Counts and timings only: nothing that identifies a person or an agency.
      expect(text).not.toContain('admin@metrics-co.test');
      expect(text).not.toContain('metrics-co');
    });
  });

  describe('request ids', () => {
    it('go back on every API response, a different one each time', async () => {
      await resetData();
      const tenant = await makeTenant('reqid-co');
      await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@reqid-co.test');
      const admin = await signIn('reqid-co', 'admin@reqid-co.test');
      const ok = await call('students', 'GET', { caller: admin });
      const refused = await call('students', 'GET', { caller: null });
      const ids = [ok, refused].map((r) => r.headers.get('x-request-id'));
      expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id ?? ''))).toBe(true);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('the report cache against a real Redis', () => {
    it('is shared, round-trips the dashboard as JSON, and is replaced when it expires', async () => {
      await resetData();
      const tenant = await makeTenant('cache-co');
      const admin = await makeUser(tenant.id, 'TENANT_ADMIN');
      await makeLead(tenant.id);
      process.env['REPORT_CACHE_SECONDS'] = '60';
      await useRedis(true);

      const first = await reports.dashboard(ctxFor(admin));
      expect(first.cards.activeLeads).toBe(1);
      const keys = await redis.keys('cache:*');
      expect(keys.some((k) => k.includes(`dash-cards:${tenant.id}`))).toBe(true);
      expect(keys.some((k) => k.includes(`dash-insights:${tenant.id}:all`))).toBe(true);

      // Another web instance (nothing in this process's memory) gets the stored answer, not a recompute.
      await makeLead(tenant.id);
      clearCacheForTests();
      const second = await reports.dashboard(ctxFor(admin));
      expect(second.cards.activeLeads).toBe(1);
      expect(second.funnel).toEqual(first.funnel);
      expect(second.trend).toEqual(first.trend);

      // Once it has aged past its time it is replaced; here by removing it.
      await redis.del(...keys);
      const third = await reports.dashboard(ctxFor(admin));
      expect(third.cards.activeLeads).toBe(2);
    });

    it('serves an old answer at once and refreshes it in the background', async () => {
      await resetData();
      const tenant = await makeTenant('swr-co');
      const admin = await makeUser(tenant.id, 'TENANT_ADMIN');
      await makeLead(tenant.id);
      process.env['REPORT_CACHE_SECONDS'] = '60';
      await useRedis(true);

      await reports.funnel(ctxFor(admin), {});
      const [key] = await redis.keys('cache:*:rep:*:funnel:*');
      expect(key).toBeDefined();
      const entry = JSON.parse((await redis.get(key!))!) as {
        value: { stage: string; count: number }[];
        computedAt: number;
      };
      // Two minutes old: past the minute it is fresh for, inside the ten it may still be served.
      await redis.set(key!, JSON.stringify({ ...entry, computedAt: Date.now() - 120_000 }), 'EX', 600);
      await makeLead(tenant.id);
      clearCacheForTests();

      const served = await reports.funnel(ctxFor(admin), {});
      expect(served.find((s) => s.stage === 'NEW')!.count).toBe(1); // the old answer, immediately
      // ...and a moment later the stored answer has been brought up to date.
      const deadline = Date.now() + 10_000;
      let fresh = 1;
      while (fresh !== 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const stored = JSON.parse((await redis.get(key!))!) as typeof entry;
        fresh = stored.value.find((s) => s.stage === 'NEW')!.count;
      }
      expect(fresh).toBe(2);
    });
  });
});
