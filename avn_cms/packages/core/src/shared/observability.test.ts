import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WORKER_HEARTBEAT_KEY,
  WORKER_STALE_AFTER_SECONDS,
  captureError,
  logEvent,
  workerStatus,
  writeWorkerHeartbeat,
} from './observability';

afterEach(() => vi.restoreAllMocks());

describe('logEvent and captureError', () => {
  it('write one JSON line with the level and the fields', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logEvent('info', 'request', { requestId: 'abc', status: 200 });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      level: 'info',
      msg: 'request',
      requestId: 'abc',
      status: 200,
    });
  });

  it('send errors to stderr with the stack, so a log collector can alert on level "error"', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    captureError(new Error('boom'), 'unhandled', { requestId: 'r1' });
    const line = JSON.parse(err.mock.calls[0]![0] as string) as Record<string, string>;
    expect(line).toMatchObject({ level: 'error', msg: 'unhandled', requestId: 'r1' });
    expect(line['error']).toContain('boom');
    expect(line['error']).toContain('at ');
  });

  it('cope with something that is not an Error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    captureError('plain string', 'unhandled');
    expect(JSON.parse(err.mock.calls[0]![0] as string).error).toBe('plain string');
  });
});

describe('worker heartbeat', () => {
  it('is written with an expiry, so a dead worker disappears by itself', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const before = Date.now();
    await writeWorkerHeartbeat({ set }, before - 5000);
    const [key, value, mode, seconds] = set.mock.calls[0]!;
    expect(key).toBe(WORKER_HEARTBEAT_KEY);
    expect(mode).toBe('EX');
    expect(seconds).toBeGreaterThan(WORKER_STALE_AFTER_SECONDS);
    const beat = JSON.parse(value as string) as { at: number; startedAt: number; pid: number };
    expect(beat.at).toBeGreaterThanOrEqual(before);
    expect(beat.startedAt).toBe(before - 5000);
    expect(beat.pid).toBe(process.pid);
  });

  it('is reported as not configured when there is no Redis to carry it', async () => {
    expect(await workerStatus()).toEqual({ status: 'not_configured', ageSeconds: null });
  });
});
