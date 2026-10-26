/**
 * Load test: staff using the web app against the load-test database (docs/SCALABILITY.md).
 *
 *   pnpm build && pnpm load:up && pnpm load:migrate && pnpm load:seed --to 100000
 *   pnpm load:run --label 100k            # --cache 0 turns the dashboard/report cache off
 *
 * Starts the production server (`next start`) against the load database, then:
 *  1. BASELINE: each kind of request, one at a time (what a single user feels with nobody else on).
 *  2. MIXED: many staff at once (admins, counselors, telecallers), each pausing between actions like a
 *     person would, doing the reads and writes a working day is made of, while websites post enquiries.
 *
 * It prints a table and writes load-results/<label>.json. Latencies are what the *server* took from
 * request to last byte, on this machine; the numbers are in the docs with that caveat.
 * Rate limits stay on: each virtual person stays under them, as a real one does.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createClient } from '@avn-cms/db/testing';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const LABEL = arg('label', 'run');
const PORT = Number(arg('port', '3302'));
const BASE = `http://localhost:${PORT}`;
/** How many web servers to start (a production site runs several behind a load balancer); people are spread over them. */
const INSTANCES = Number(arg('instances', '1'));
const BASES = Array.from({ length: INSTANCES }, (_, i) => `http://localhost:${PORT + i}`);
let nextBase = 0;
const VUS = Number(arg('vus', '150'));
const DURATION_S = Number(arg('duration', '90'));
const BASELINE_N = Number(arg('baseline', '60'));
const THINK_MS = Number(arg('think', '700'));
/** How long the server reuses dashboard and report answers (0 measures the queries themselves). */
const CACHE_SECONDS = arg('cache', '60');
const OWNER_URL =
  process.env['LOAD_DATABASE_OWNER_URL'] ??
  'postgresql://avn_owner:avn_owner_local_only@127.0.0.1:55460/avn_cms_load';
const APP_URL =
  process.env['LOAD_DATABASE_URL'] ?? 'postgresql://avn_app:avn_app_local_only@127.0.0.1:55460/avn_cms_load';

/** What every JSON answer from the app looks like (`{ data, meta }`). */
interface Reply {
  data?: unknown;
  meta?: { nextCursor?: string | null };
}
const pad = (n: number, w = 3) => String(n).padStart(w, '0');

// ── What is in the database ──────────────────────────────────────────────────

const owner = createClient(OWNER_URL, { poolMax: 2, statementTimeoutMs: 600_000 });
const [leadCount] = await owner.$queryRawUnsafe<{ n: bigint }[]>(
  `SELECT count(*) AS n FROM leads WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'bigco')`,
);
const N = Number(leadCount?.n ?? 0);
if (N === 0) throw new Error('The load database is empty. Run `pnpm load:seed` first.');
const FIRST = [
  'Asha',
  'Ravi',
  'Priya',
  'Kiran',
  'Sai',
  'Lakshmi',
  'Venkat',
  'Anitha',
  'Suresh',
  'Divya',
  'Ramesh',
  'Meena',
  'Arjun',
  'Neha',
  'Harsha',
  'Pooja',
  'Teja',
  'Swathi',
  'Mahesh',
  'Bhavana',
];
/** The name the seed gave row `i`. */
const pseudo = (i: number) =>
  createHash('md5')
    .update(String(i))
    .digest('hex')
    .slice(0, 6)
    .replace(/\d/g, (d) => 'ghjklmnpqr'[Number(d)]!);
const studentName = (i: number) => `${FIRST[i % 20]} ${pseudo(i)}`;
const studentPhone = (i: number) => String(6_000_000_000 + i);
const rand = (max: number) => 1 + Math.floor(Math.random() * max);
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

// ── People ───────────────────────────────────────────────────────────────────

interface Person {
  email: string;
  role: 'admin' | 'counselor' | 'telecaller';
  cookie: string;
  csrf: string;
  ip: string;
  /** What this person has seen, so the next click can follow it. */
  leadIds: string[];
  followUpIds: string[];
  cursor: string | null;
}
const person = (email: string, role: Person['role'], k: number): Person => ({
  email,
  role,
  cookie: `avn_session=lt-${email}`,
  csrf: `lc-${email}`,
  ip: `10.20.${Math.floor(k / 250)}.${(k % 250) + 1}`,
  leadIds: [],
  followUpIds: [],
  cursor: null,
});
const people: Person[] = [
  ...[1, 2].map((i) => person(`a${pad(i)}@bigco.test`, 'admin', i)),
  ...Array.from({ length: 60 }, (_, i) => person(`c${pad(i + 1)}@bigco.test`, 'counselor', 10 + i)),
  ...Array.from({ length: 88 }, (_, i) => person(`t${pad(i + 1)}@bigco.test`, 'telecaller', 100 + i)),
];

// ── HTTP ─────────────────────────────────────────────────────────────────────

interface Sample {
  name: string;
  ms: number;
  status: number;
}
const samples: Sample[] = [];
let recording = true;

async function http(
  p: Person | null,
  name: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<{ status: number; json: Reply | null }> {
  const headers: Record<string, string> = { 'x-forwarded-for': p?.ip ?? '10.99.0.1', ...extra };
  if (p) {
    headers['cookie'] = p.cookie;
    if (method !== 'GET') headers['x-csrf-token'] = p.csrf;
  }
  const base = BASES[nextBase++ % BASES.length]!;
  if (method !== 'GET') headers['origin'] = base;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  let status: number;
  let json: Reply | null = null;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      redirect: 'manual',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    status = res.status;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      /* a page, not JSON */
    }
  } catch {
    status = 0;
  }
  if (recording) samples.push({ name, ms: performance.now() - started, status });
  return { status, json };
}

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

// ── What people do ───────────────────────────────────────────────────────────

let sourceIds: string[] = [];
const STAGES = ['NEW', 'CONTACTED', 'INTERESTED', 'FOLLOW_UP_REQUIRED', 'POTENTIAL', 'APPLICATION_STARTED'];
const remember = (p: Person, json: Reply | null) => {
  const items = json?.data;
  if (Array.isArray(items)) {
    p.leadIds = items.map((r: { id: string }) => r.id).filter(Boolean);
  }
  p.cursor = json?.meta?.nextCursor ?? null;
};

type Action = { name: string; weight: number; roles: Person['role'][]; run: (p: Person) => Promise<void> };
const actions: Action[] = [
  {
    name: 'leads: first page, newest',
    weight: 14,
    roles: ['admin', 'counselor', 'telecaller'],
    run: async (p) =>
      remember(
        p,
        (await http(p, 'leads: first page, newest', 'GET', `/api/students?${qs({ limit: 50 })}`)).json,
      ),
  },
  {
    name: 'leads: next page',
    weight: 6,
    roles: ['admin', 'counselor', 'telecaller'],
    run: async (p) => {
      if (!p.cursor)
        return void (await http(p, 'leads: first page, newest', 'GET', `/api/students?${qs({ limit: 50 })}`));
      remember(
        p,
        (await http(p, 'leads: next page', 'GET', `/api/students?${qs({ limit: 50, cursor: p.cursor })}`))
          .json,
      );
    },
  },
  {
    name: 'leads: search by phone digits',
    weight: 9,
    roles: ['admin', 'counselor'],
    run: async (p) => {
      const i = rand(N);
      remember(
        p,
        (
          await http(
            p,
            'leads: search by phone digits',
            'GET',
            `/api/students?${qs({ q: studentPhone(i).slice(-6) })}`,
          )
        ).json,
      );
    },
  },
  {
    name: 'leads: search by full name',
    weight: 5,
    roles: ['admin', 'counselor'],
    run: async (p) => {
      remember(
        p,
        (
          await http(
            p,
            'leads: search by full name',
            'GET',
            `/api/students?${qs({ q: studentName(rand(N)) })}`,
          )
        ).json,
      );
    },
  },
  {
    name: 'leads: search by first name only',
    weight: 2,
    roles: ['admin', 'counselor'],
    run: async (p) => {
      remember(
        p,
        (await http(p, 'leads: search by first name only', 'GET', `/api/students?${qs({ q: pick(FIRST) })}`))
          .json,
      );
    },
  },
  {
    name: 'leads: filter by stage and source',
    weight: 7,
    roles: ['admin', 'counselor'],
    run: async (p) => {
      remember(
        p,
        (
          await http(
            p,
            'leads: filter by stage and source',
            'GET',
            `/api/students?${qs({ stage: pick(STAGES), sourceId: pick(sourceIds), limit: 50 })}`,
          )
        ).json,
      );
    },
  },
  {
    name: 'leads: filter by state',
    weight: 3,
    roles: ['admin'],
    run: async (p) => {
      remember(
        p,
        (
          await http(
            p,
            'leads: filter by state',
            'GET',
            `/api/students?${qs({ state: pick(['Andhra Pradesh', 'Telangana', 'Karnataka']), limit: 50 })}`,
          )
        ).json,
      );
    },
  },
  {
    name: 'leads: my leads / today / overdue',
    weight: 10,
    roles: ['counselor', 'telecaller'],
    run: async (p) => {
      const view = pick(['mine', 'today', 'overdue', 'hot', 'potential']);
      remember(
        p,
        (
          await http(
            p,
            'leads: my leads / today / overdue',
            'GET',
            `/api/students?${qs({ view, limit: 50 })}`,
          )
        ).json,
      );
    },
  },
  {
    name: 'leads: unassigned / closed views',
    weight: 2,
    roles: ['admin'],
    run: async (p) => {
      remember(
        p,
        (
          await http(
            p,
            'leads: unassigned / closed views',
            'GET',
            `/api/students?${qs({ view: pick(['unassigned', 'closed', 'overdue']), limit: 50 })}`,
          )
        ).json,
      );
    },
  },
  {
    name: 'lead: open one (detail)',
    weight: 14,
    roles: ['admin', 'counselor'],
    run: async (p) => {
      if (p.leadIds.length === 0)
        return void (await http(p, 'leads: first page, newest', 'GET', `/api/students?${qs({ limit: 50 })}`));
      await http(p, 'lead: open one (detail)', 'GET', `/api/leads/${pick(p.leadIds)}`);
    },
  },
  {
    name: 'lead: timeline',
    weight: 5,
    roles: ['admin', 'counselor'],
    run: async (p) => {
      if (p.leadIds.length) await http(p, 'lead: timeline', 'GET', `/api/leads/${pick(p.leadIds)}/timeline`);
    },
  },
  {
    name: 'calls: my queue (today / overdue / upcoming)',
    weight: 22,
    roles: ['telecaller', 'counselor'],
    run: async (p) => {
      const r = await http(
        p,
        'calls: my queue (today / overdue / upcoming)',
        'GET',
        `/api/followups?${qs({ bucket: pick(['today', 'overdue', 'upcoming', 'pending']) })}`,
      );
      const items = r.json?.data;
      if (Array.isArray(items)) p.followUpIds = items.map((x: { id: string }) => x.id).filter(Boolean);
    },
  },
  {
    name: 'calls: log an outcome',
    weight: 8,
    roles: ['telecaller', 'counselor'],
    run: async (p) => {
      if (p.followUpIds.length === 0) return;
      await http(p, 'calls: log an outcome', 'PATCH', `/api/followups/${p.followUpIds.shift()}`, {
        disposition: pick(['NO_ANSWER', 'CALL_BACK_LATER', 'BUSY']),
        outcomeNote: 'Load test call',
        nextCallAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    },
  },
  {
    name: 'lead: add a note',
    weight: 5,
    roles: ['counselor', 'telecaller'],
    run: async (p) => {
      if (p.leadIds.length)
        await http(p, 'lead: add a note', 'POST', `/api/leads/${pick(p.leadIds)}/notes`, {
          body: 'Load test note',
        });
    },
  },
  {
    name: 'lead: change stage',
    weight: 3,
    roles: ['admin'],
    run: async (p) => {
      if (p.leadIds.length)
        await http(p, 'lead: change stage', 'PATCH', `/api/leads/${pick(p.leadIds)}`, {
          stage: pick(['CONTACTED', 'INTERESTED', 'POTENTIAL']),
        });
    },
  },
  {
    name: 'student: add a new one',
    weight: 2,
    roles: ['counselor', 'admin'],
    run: async (p) => {
      const n = 7_000_000_000 + Math.floor(Math.random() * 999_999_999);
      await http(p, 'student: add a new one', 'POST', '/api/students', {
        name: `Load New ${pseudo(n)}`,
        phone: String(n),
        sourceId: pick(sourceIds),
      });
    },
  },
  {
    name: 'web leads: inbox',
    weight: 8,
    roles: ['admin'],
    run: async (p) =>
      void (await http(
        p,
        'web leads: inbox',
        'GET',
        `/api/web-leads?${qs({ status: pick(['NEW', 'DUPLICATE', 'CONVERTED']), limit: 50 })}`,
      )),
  },
  {
    name: 'dashboard (page)',
    weight: 14,
    roles: ['admin', 'counselor', 'telecaller'],
    run: async (p) => void (await http(p, 'dashboard (page)', 'GET', '/app/dashboard')),
  },
  {
    name: 'reports: funnel / sources / team / status',
    weight: 10,
    roles: ['admin'],
    run: async (p) => {
      // The Reports page opens on the last 30 days; now and then someone widens it to all time.
      const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const range = Math.random() < 0.8 ? qs({ dateFrom: from }) : '';
      await http(
        p,
        'reports: funnel / sources / team / status',
        'GET',
        `/api/reports/${pick(['funnel', 'sources', 'team', 'status', 'followups'])}?${range}`,
      );
    },
  },
  {
    name: 'audit log',
    weight: 3,
    roles: ['admin'],
    run: async (p) => void (await http(p, 'audit log', 'GET', `/api/audit?${qs({ limit: 50 })}`)),
  },
  {
    name: 'notifications badge',
    weight: 12,
    roles: ['admin', 'counselor', 'telecaller'],
    run: async (p) => void (await http(p, 'notifications badge', 'GET', '/api/notifications/unread')),
  },
];

let siteSeq = 0;
/** A website posting an enquiry (LeadXP-compatible), with its own credential. */
async function intake(name = 'intake: website enquiry'): Promise<void> {
  const k = (siteSeq++ % 50) + 1;
  const auth = `Basic ${Buffer.from(`wl_${String(k).padStart(12, '0')}:load-secret-${k}-0123456789abcdef`).toString('base64')}`;
  const n = 8_000_000_000 + Math.floor(Math.random() * 999_999_999);
  await http(
    null,
    name,
    'POST',
    '/api/webleads',
    {
      name: `Web ${pseudo(n)}`,
      mobile: String(n),
      email: `${pseudo(n)}@example.test`,
      message: 'Need details for MBBS abroad',
      neet_score: 400 + (n % 300),
      preferred_country: pick(['Russia', 'Georgia', 'Kyrgyzstan']),
      source: 'Landing Page',
    },
    { authorization: auth, 'x-forwarded-for': `10.77.${k}.${(n % 250) + 1}` },
  );
}

// ── Reporting ────────────────────────────────────────────────────────────────

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
interface Row {
  name: string;
  count: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errors: number;
}
function summarize(list: Sample[], seconds: number): Row[] {
  const byName = new Map<string, Sample[]>();
  for (const s of list) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  return [...byName.entries()]
    .map(([name, rows]) => {
      const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
      return {
        name,
        count: rows.length,
        rps: rows.length / seconds,
        p50: pct(ms, 50),
        p95: pct(ms, 95),
        p99: pct(ms, 99),
        max: ms[ms.length - 1] ?? 0,
        errors: rows.filter((r) => r.status === 0 || r.status >= 500 || r.status === 429).length,
      };
    })
    .sort((a, b) => b.p95 - a.p95);
}
function table(title: string, rows: Row[]) {
  console.log(`\n${title}`);
  console.log(
    'request'.padEnd(46) +
      'n'.padStart(7) +
      'req/s'.padStart(8) +
      'p50 ms'.padStart(9) +
      'p95 ms'.padStart(9) +
      'p99 ms'.padStart(9) +
      'max ms'.padStart(9) +
      'errors'.padStart(8),
  );
  for (const r of rows) {
    console.log(
      r.name.padEnd(46) +
        String(r.count).padStart(7) +
        r.rps.toFixed(1).padStart(8) +
        r.p50.toFixed(0).padStart(9) +
        r.p95.toFixed(0).padStart(9) +
        r.p99.toFixed(0).padStart(9) +
        r.max.toFixed(0).padStart(9) +
        String(r.errors).padStart(8),
    );
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

const servers: ChildProcess[] = [];
async function startServer(index: number): Promise<void> {
  if (flag('no-server')) return;
  const cwd = fileURLToPath(new URL('../../apps/web', import.meta.url));
  const base = BASES[index]!;
  const server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT + index)], {
    cwd,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_URL: BASE,
      DATABASE_URL: APP_URL,
      DATABASE_OWNER_URL: OWNER_URL,
      REDIS_URL: '',
      SMTP_HOST: '',
      SMTP_PORT: '',
      TRUSTED_PROXY_HOPS: '1',
      REPORT_CACHE_SECONDS: CACHE_SECONDS,
      MFA_REQUIRED_ROLES: '',
      R2_BUCKET: '',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
      R2_ACCOUNT_ID: '',
      R2_ENDPOINT: '',
      CLAMAV_HOST: '',
    },
  });
  // Both pipes must be read all the time: the server writes its log to them, and on Windows a full pipe stops
  // it dead in the middle of a request (found when a 150-person run froze after the access log was added).
  // The server's own log is kept next to the results.
  servers.push(server);
  mkdirSync(fileURLToPath(new URL('../../load-results', import.meta.url)), { recursive: true });
  const serverLog = createWriteStream(
    fileURLToPath(
      new URL(`../../load-results/${LABEL}.server${index === 0 ? '' : index + 1}.log`, import.meta.url),
    ),
  );
  server.stdout?.on('data', (d: Buffer) => serverLog.write(d));
  server.stderr?.on('data', (d: Buffer) => {
    serverLog.write(d);
    const text = d.toString();
    if (/error/i.test(text) && !/Deprecation|trace-deprecation/.test(text))
      process.stderr.write(`[server] ${text}`);
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).status < 600) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The server did not start.');
}

// ── Run ──────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = {
  label: LABEL,
  leads: N,
  vus: VUS,
  reportCacheSeconds: Number(CACHE_SECONDS),
  durationSeconds: DURATION_S,
  at: new Date().toISOString(),
};

try {
  await Promise.all(BASES.map((_, i) => startServer(i)));
  console.log(
    `${INSTANCES} server${INSTANCES === 1 ? ' is' : 's are'} up (${BASES.join(', ')}); ${N.toLocaleString('en-IN')} leads in the big workspace. Warming up…`,
  );
  // Warm up: sessions, the planner's first look at each table, JIT.
  const admin = people[0]!;
  const warm = (await http(admin, 'warm', 'GET', '/api/directory?kind=sources')).json?.data;
  sourceIds = (Array.isArray(warm) ? (warm as { id: string }[]) : []).map((s) => s.id);
  if (sourceIds.length === 0)
    throw new Error(
      'Could not read the lead sources: are the sessions seeded and the server on the load database?',
    );
  recording = false;
  for (let i = 0; i < 30; i++)
    await Promise.all(
      people
        .slice(0, 20)
        .map((p) =>
          actions[i % actions.length]!.roles.includes(p.role)
            ? actions[i % actions.length]!.run(p)
            : Promise.resolve(),
        ),
    );
  await owner.$executeRawUnsafe('SELECT pg_stat_statements_reset()');

  console.log('Baseline…');
  // 1. Baseline: one person, one request at a time.
  recording = true;
  samples.length = 0;
  const baselineStart = performance.now();
  for (const action of actions) {
    // Spread over everyone who does this: one person asking 20 times a second would measure the rate limit.
    const who = people.filter((p) => action.roles.includes(p.role));
    for (let i = 0; i < BASELINE_N; i++) await action.run(who[i % who.length]!);
  }
  for (let i = 0; i < BASELINE_N; i++) await intake();
  const baseline = summarize(samples, (performance.now() - baselineStart) / 1000);
  table(`BASELINE at ${N.toLocaleString('en-IN')} leads (one request at a time)`, baseline);
  results['baseline'] = baseline;

  console.log(`Mixed: ${VUS} people for ${DURATION_S} s…`);
  // 2. Mixed: many people at once.
  samples.length = 0;
  const writes = new Map<string, number>();
  const end = performance.now() + DURATION_S * 1000;
  const mixedStart = performance.now();
  const users = Array.from({ length: VUS }, (_, i) => people[i % people.length]!);
  await Promise.all([
    ...users.map(async (p) => {
      await sleep(Math.random() * 2000);
      const mine = actions.filter((a) => a.roles.includes(p.role));
      const mineTotal = mine.reduce((sum, a) => sum + a.weight, 0);
      while (performance.now() < end) {
        let roll = Math.random() * mineTotal;
        const action = mine.find((a) => (roll -= a.weight) < 0) ?? mine[0]!;
        await action.run(p);
        writes.set(action.name, (writes.get(action.name) ?? 0) + 1);
        await sleep(THINK_MS * (0.5 + Math.random()));
      }
    }),
    // Websites posting enquiries, about 3 a second.
    (async () => {
      while (performance.now() < end) {
        await Promise.all([intake(), intake(), intake()]);
        await sleep(1000);
      }
    })(),
  ]);
  const mixed = summarize(samples, (performance.now() - mixedStart) / 1000);
  table(`MIXED: ${VUS} people + websites for ${DURATION_S} s at ${N.toLocaleString('en-IN')} leads`, mixed);
  const all = samples.map((s) => s.ms).sort((a, b) => a - b);
  const seconds = (performance.now() - mixedStart) / 1000;
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500 || s.status === 429).length;
  console.log(
    `\nAll requests: ${samples.length} (${(samples.length / seconds).toFixed(0)} per second), p50 ${pct(all, 50).toFixed(0)} ms, p95 ${pct(all, 95).toFixed(0)} ms, p99 ${pct(all, 99).toFixed(0)} ms, errors ${errors}`,
  );
  results['mixed'] = mixed;
  results['mixedTotals'] = {
    requests: samples.length,
    perSecond: samples.length / seconds,
    p50: pct(all, 50),
    p95: pct(all, 95),
    p99: pct(all, 99),
    errors,
  };

  // What the database spent its time on.
  const top = await owner.$queryRawUnsafe<
    { calls: bigint; mean_ms: number; total_s: number; query: string }[]
  >(
    `SELECT calls, round(mean_exec_time::numeric, 2)::float AS mean_ms, round((total_exec_time/1000)::numeric, 1)::float AS total_s, left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query
     FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC LIMIT 12`,
  );
  console.log('\nDatabase: the statements that took the most time in total');
  for (const t of top)
    console.log(
      `${String(t.total_s).padStart(8)} s  ${String(t.calls).padStart(8)} calls  ${String(t.mean_ms).padStart(8)} ms each  ${t.query}`,
    );
  results['topStatements'] = top.map((t) => ({ ...t, calls: Number(t.calls) }));

  mkdirSync(fileURLToPath(new URL('../../load-results', import.meta.url)), { recursive: true });
  writeFileSync(
    fileURLToPath(new URL(`../../load-results/${LABEL}.json`, import.meta.url)),
    JSON.stringify(results, null, 2),
  );
  console.log(`\nSaved load-results/${LABEL}.json`);
} finally {
  // On Windows the server is started through a shell, so the whole tree has to go, not just the shell.
  for (const server of servers) {
    if (server.pid && process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      server.kill();
    }
  }
  await owner.$disconnect();
}
