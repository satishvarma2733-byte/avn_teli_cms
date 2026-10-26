import { readyRedis, sharedRedis } from './rate-limit';

/**
 * What an operator needs to run the app (docs/RUNBOOK.md): one JSON line per event on stdout/stderr that any
 * log collector can ship and alert on (`"level":"error"`), and a heartbeat that says the worker is alive.
 * Nothing here sends data anywhere by itself.
 */

type Level = 'info' | 'warn' | 'error';

export function logEvent(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/**
 * The one place errors are recorded. A log line today; this is where an error tracker (Sentry and the like)
 * would be plugged in without touching the callers.
 */
export function captureError(err: unknown, msg: string, context: Record<string, unknown> = {}): void {
  logEvent('error', msg, {
    ...context,
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
}

// ── Worker heartbeat ─────────────────────────────────────────────────────────

export const WORKER_HEARTBEAT_KEY = 'avn:worker:heartbeat';
/** The worker writes every 15 s; a beat older than this means it is not running. */
export const WORKER_STALE_AFTER_SECONDS = 45;

/** Called by the worker on a timer. `client` is the worker's own Redis connection. */
export async function writeWorkerHeartbeat(
  client: { set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown> },
  startedAt: number,
): Promise<void> {
  await client.set(
    WORKER_HEARTBEAT_KEY,
    JSON.stringify({ at: Date.now(), startedAt, pid: process.pid }),
    'EX',
    WORKER_STALE_AFTER_SECONDS * 4,
  );
}

export interface WorkerStatus {
  /** "not_configured" without Redis: the jobs then run inside the web process (local development). */
  status: 'up' | 'down' | 'not_configured';
  ageSeconds: number | null;
}

export async function workerStatus(): Promise<WorkerStatus> {
  if (!sharedRedis()) return { status: 'not_configured', ageSeconds: null };
  const client = await readyRedis(1500);
  if (!client) return { status: 'down', ageSeconds: null };
  try {
    const raw = await client.get(WORKER_HEARTBEAT_KEY);
    if (!raw) return { status: 'down', ageSeconds: null };
    const at = Number((JSON.parse(raw) as { at?: number }).at);
    if (!Number.isFinite(at)) return { status: 'down', ageSeconds: null };
    const ageSeconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    return { status: ageSeconds <= WORKER_STALE_AFTER_SECONDS ? 'up' : 'down', ageSeconds };
  } catch {
    return { status: 'down', ageSeconds: null };
  }
}
