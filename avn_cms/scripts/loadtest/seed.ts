/**
 * Fills the load-test database (docker-compose.load.yml) with a believable workspace, in SQL, fast.
 *
 *   pnpm load:seed --to 100000                 # the first 100,000 leads, plus the people, sessions, web leads…
 *   pnpm load:seed --from 100000 --to 1000000  # add up to 1,000,000 (what the load test measures at each size)
 *
 * The big workspace ("bigco") gets, per lead: a student, 1–2 assignments, an open or closed follow-up for
 * some, stage history, activity, notes for some. Rows are spread over three years, in realistic stage and
 * source proportions, with some calls overdue and some due soon. Twenty small workspaces sit beside it
 * (many tenants is what row-level security has to plan across). Ids are derived from the row number, so
 * ranges can be added later and a re-run of the same range is refused instead of duplicating.
 *
 * Refuses to run against anything but the load database (name must end in `_load`).
 */
import { createHash } from 'node:crypto';

import { hashPassword } from '@avn-cms/auth';
import { createClient } from '@avn-cms/db/testing';

const OWNER_URL =
  process.env['LOAD_DATABASE_OWNER_URL'] ??
  'postgresql://avn_owner:avn_owner_local_only@127.0.0.1:55460/avn_cms_load';
if (!/\/[a-z0-9_]*_load(\?|$)/.test(OWNER_URL))
  throw new Error('The load seed only runs against a database named *_load.');

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isInteger(v) || v < 0) throw new Error(`--${name} must be a whole number`);
  return v;
};
const FROM = arg('from', 0);
const TO = arg('to', 100_000);
const TOTAL = arg('total', 1_000_000);
const SMALL = arg('small', 20);
const WEB_LEADS = arg('web-leads', 200_000);
const AUDIT = arg('audit', 500_000);
if (TO <= FROM) throw new Error('--to must be above --from');

const db = createClient(OWNER_URL, { poolMax: 2, statementTimeoutMs: 3_600_000 });
const lit = (a: string[]) => `ARRAY[${a.map((x) => `'${x}'`).join(',')}]::text[]`;
const FIRST = lit([
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
]);
const TOWN = lit([
  'Guntur',
  'Vijayawada',
  'Nellore',
  'Kakinada',
  'Tirupati',
  'Kurnool',
  'Hyderabad',
  'Warangal',
  'Chennai',
  'Bengaluru',
  'Vizag',
  'Rajahmundry',
]);
const DISTRICT = lit([
  'Guntur',
  'NTR',
  'Nellore',
  'East Godavari',
  'Tirupati',
  'Kurnool',
  'Hyderabad',
  'Warangal',
  'Chennai',
  'Bengaluru Urban',
  'Visakhapatnam',
  'East Godavari',
]);
const STATE = lit([
  'Andhra Pradesh',
  'Andhra Pradesh',
  'Andhra Pradesh',
  'Andhra Pradesh',
  'Andhra Pradesh',
  'Andhra Pradesh',
  'Telangana',
  'Telangana',
  'Tamil Nadu',
  'Karnataka',
  'Andhra Pradesh',
  'Andhra Pradesh',
]);
const COUNTRY = lit(['Russia', 'Georgia', 'Kyrgyzstan', 'Philippines', 'Uzbekistan', 'Kazakhstan']);
const DISPOSITION = lit([
  'NO_ANSWER',
  'BUSY',
  'CALL_BACK_LATER',
  'INTERESTED',
  'COMPLETED',
  'SWITCHED_OFF',
  'AWAITING_FEEDBACK',
]);
const SOURCES: [string, string][] = [
  ['WEBSITE', 'Website'],
  ['GOOGLE_ADS', 'Google Ads'],
  ['META_ADS', 'Meta Ads'],
  ['DIRECT_CALL', 'Direct Call'],
  ['REFERENCE', 'Reference'],
  ['WALK_IN', 'Walk-in'],
  ['SHEET_DATA', 'Sheet Data'],
  ['OTHER', 'Other'],
];
const pseudoName = (n: string) => `translate(substr(md5((${n})::text),1,6),'0123456789','ghjklmnpqr')`;

const sql = (text: string) => db.$executeRawUnsafe(text);
const rows = <T>(text: string) => db.$queryRawUnsafe<T[]>(text);
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const out = await run();
  console.log(`  ${label}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
  return out;
}

/** Expressions of the row number `i`, so every dependent row agrees with its lead. */
const x = {
  stage: `(CASE WHEN ((i*37)%100) < 25 THEN 'NEW' WHEN ((i*37)%100) < 40 THEN 'CONTACTED' WHEN ((i*37)%100) < 52 THEN 'INTERESTED'
    WHEN ((i*37)%100) < 60 THEN 'FOLLOW_UP_REQUIRED' WHEN ((i*37)%100) < 66 THEN 'POTENTIAL' WHEN ((i*37)%100) < 71 THEN 'APPLICATION_STARTED'
    WHEN ((i*37)%100) < 75 THEN 'DOCUMENTS_PENDING' WHEN ((i*37)%100) < 78 THEN 'APPLICATION_SUBMITTED' WHEN ((i*37)%100) < 80 THEN 'OFFER_RECEIVED'
    WHEN ((i*37)%100) < 82 THEN 'ADMISSION_CONFIRMED' WHEN ((i*37)%100) < 85 THEN 'ENROLLED' WHEN ((i*37)%100) < 91 THEN 'NOT_INTERESTED'
    WHEN ((i*37)%100) < 93 THEN 'INVALID' WHEN ((i*37)%100) < 96 THEN 'UNREACHABLE' WHEN ((i*37)%100) < 99 THEN 'LOST' ELSE 'LONG_TERM' END)::lead_stage`,
  // 4 in 10 open leads (the stages before Enrolled) have a call booked.
  hasCall: `((i % 10) < 4 AND ((i*37)%100) < 82)`,
  callAt: `(now() + (((i*13) % 120) - 36) * interval '1 hour')`,
};

async function sources(tenant: string): Promise<void> {
  for (const [code, label] of SOURCES) {
    await sql(
      `INSERT INTO lead_sources (id, tenant_id, code, label, is_active) VALUES (gen_random_uuid(), '${tenant}', '${code}', '${label}', true)`,
    );
  }
}

async function users(
  tenant: string,
  slug: string,
  counts: { admin: number; counselor: number; telecaller: number },
  hash: string,
) {
  for (const [role, prefix, n] of [
    ['TENANT_ADMIN', 'a', counts.admin],
    ['COUNSELOR', 'c', counts.counselor],
    ['TELECALLER', 't', counts.telecaller],
  ] as const) {
    await sql(`INSERT INTO users (id, tenant_id, role_code, name, email, password_hash, status, created_at, updated_at)
      SELECT gen_random_uuid(), '${tenant}'::uuid, '${role}'::role_code, '${role} ' || lpad(i::text, 3, '0'), '${prefix}' || lpad(i::text, 3, '0') || '@${slug}.test',
             '${hash}', 'ACTIVE'::user_status, now(), now() FROM generate_series(1, ${n}) AS g(i)`);
  }
}

async function leadsRange(
  tenant: string,
  admin: string,
  phoneBase: number,
  from: number,
  to: number,
  total: number,
) {
  const created = `(now() - ((${total} - i) * 90) * interval '1 second')`;
  const range = `generate_series(${from + 1}, ${to}) AS g(i)`;
  const sid = `md5('${tenant}s'||i)::uuid`;
  const lid = `md5('${tenant}l'||i)::uuid`;
  const people = `WITH c AS (SELECT array_agg(id ORDER BY email) a FROM users WHERE tenant_id='${tenant}' AND role_code='COUNSELOR'),
      t AS (SELECT array_agg(id ORDER BY email) a FROM users WHERE tenant_id='${tenant}' AND role_code='TELECALLER'),
      s AS (SELECT array_agg(id ORDER BY code) a FROM lead_sources WHERE tenant_id='${tenant}')`;
  await step(`students ${from + 1}–${to}`, () =>
    sql(`INSERT INTO students (id, tenant_id, name, parent_name, phone_raw, phone_e164, email, town, district, state, created_by_id, created_at, updated_at)
      SELECT ${sid}, '${tenant}'::uuid, (${FIRST})[1 + (i % 20)] || ' ' || ${pseudoName('i')}, (${FIRST})[1 + ((i/7) % 20)] || ' ' || ${pseudoName('i+1')},
        (${phoneBase} + i)::text, '+91' || (${phoneBase} + i)::text,
        CASE WHEN i % 3 = 0 THEN NULL ELSE lower(${pseudoName('i')}) || i || '@example.test' END,
        (${TOWN})[1 + (i % 12)], (${DISTRICT})[1 + (i % 12)], (${STATE})[1 + (i % 12)], '${admin}'::uuid, ${created}, ${created}
      FROM ${range}`),
  );
  await step('leads', () =>
    sql(`${people} INSERT INTO leads (id, tenant_id, student_id, source_id, stage, is_potential, priority, interest_country, interest_course, next_call_at, last_contacted_at, created_at, updated_at)
      SELECT ${lid}, '${tenant}'::uuid, ${sid}, (s.a)[1 + (i % cardinality(s.a))], ${x.stage}, (i % 9 = 0), CASE WHEN i % 7 = 0 THEN 'HOT' ELSE 'NORMAL' END::priority,
        (${COUNTRY})[1 + (i % 6)], 'MBBS', CASE WHEN ${x.hasCall} THEN ${x.callAt} END,
        CASE WHEN ((i*37)%100) < 25 THEN NULL ELSE ${created} + interval '1 day' END, ${created}, ${created}
      FROM ${range}, s`),
  );
  await step('assignments', () =>
    sql(`${people} INSERT INTO lead_assignments (id, tenant_id, lead_id, assignee_id, role_function, assigned_by_id, assigned_at, is_active)
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, (c.a)[1 + (i % cardinality(c.a))], 'COUNSELOR'::role_function, '${admin}'::uuid, ${created}, true FROM ${range}, c
      UNION ALL
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, (t.a)[1 + (i % cardinality(t.a))], 'TELECALLER'::role_function, '${admin}'::uuid, ${created}, true FROM ${range}, t WHERE (i % 10) < 7`),
  );
  await step('open follow-ups', () =>
    sql(`${people} INSERT INTO follow_ups (id, tenant_id, lead_id, scheduled_at, assignee_id, disposition, priority, is_overdue, created_by_id, created_at, updated_at)
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, ${x.callAt},
        CASE WHEN (i % 10) < 7 THEN (t.a)[1 + (i % cardinality(t.a))] ELSE (c.a)[1 + (i % cardinality(c.a))] END,
        'SCHEDULED'::call_disposition, CASE WHEN i % 7 = 0 THEN 'HOT' ELSE 'NORMAL' END::priority, ${x.callAt} < now(), '${admin}'::uuid, ${created}, ${created}
      FROM ${range}, c, t WHERE ${x.hasCall}`),
  );
  await step('closed follow-ups', () =>
    sql(`${people} INSERT INTO follow_ups (id, tenant_id, lead_id, scheduled_at, assignee_id, disposition, priority, outcome_note, completed_at, is_overdue, created_by_id, created_at, updated_at)
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, ${created} + interval '2 days', (c.a)[1 + (i % cardinality(c.a))],
        (${DISPOSITION})[1 + (i % 7)]::call_disposition, 'NORMAL'::priority, 'Spoke with the parent; sharing fee details.', ${created} + interval '2 days 1 hour', false, '${admin}'::uuid, ${created}, ${created}
      FROM ${range}, c WHERE (i % 100) < 25`),
  );
  await step('stage history', () =>
    sql(`INSERT INTO lead_status_history (id, tenant_id, lead_id, from_stage, to_stage, changed_by_id, created_at)
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, NULL::lead_stage, 'NEW'::lead_stage, '${admin}'::uuid, ${created} FROM ${range}
      UNION ALL
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, 'NEW'::lead_stage, ${x.stage}, '${admin}'::uuid, ${created} + interval '1 day' FROM ${range} WHERE ((i*37)%100) >= 25`),
  );
  await step('activities', () =>
    sql(`INSERT INTO activities (id, tenant_id, lead_id, student_id, type, actor_id, summary, created_at)
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, ${sid}, 'SYSTEM'::activity_type, '${admin}'::uuid, 'Student added (source: Website)', ${created} FROM ${range}
      UNION ALL
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, ${sid}, 'CALL'::activity_type, '${admin}'::uuid, 'Call: Call back later', ${created} + interval '2 days' FROM ${range} WHERE i % 2 = 0`),
  );
  await step('notes', () =>
    sql(`INSERT INTO notes (id, tenant_id, lead_id, author_id, body, created_at)
      SELECT gen_random_uuid(), '${tenant}'::uuid, ${lid}, '${admin}'::uuid, 'Parent asked about fees and hostel; will call back after results.', ${created} + interval '3 days'
      FROM ${range} WHERE (i % 100) < 15`),
  );
}

async function webLeads(tenant: string, n: number) {
  if (n === 0) return;
  await sql(`INSERT INTO web_leads (id, tenant_id, name, phone_raw, phone_e164, email, interest_country, message, source_label, submitted_at, status, created_at)
    SELECT md5('${tenant}w'||i)::uuid, '${tenant}'::uuid, (${FIRST})[1 + (i % 20)] || ' ' || ${pseudoName('i+5')}, (7000000000 + i)::text, '+91' || (7000000000 + i)::text,
      lower(${pseudoName('i')}) || '@example.test', (${COUNTRY})[1 + (i % 6)], 'Need details for MBBS abroad',
      'Landing Page', now() - ((${n} - i) * 3) * interval '1 minute',
      (CASE WHEN i % 100 < 30 THEN 'NEW' WHEN i % 100 < 40 THEN 'DUPLICATE' WHEN i % 100 < 90 THEN 'CONVERTED' WHEN i % 100 < 98 THEN 'SPAM' ELSE 'REJECTED' END)::web_lead_status,
      now() - ((${n} - i) * 3) * interval '1 minute'
    FROM generate_series(1, ${n}) AS g(i)`);
}

async function audit(tenant: string, admin: string, n: number) {
  if (n === 0) return;
  await sql(`INSERT INTO audit_logs (id, tenant_id, user_id, action, entity_type, entity_id, new_value, created_at)
    SELECT gen_random_uuid(), '${tenant}'::uuid, '${admin}'::uuid, (ARRAY['student.create','lead.update','auth.login','student.update','web_lead.status','import.run'])[1 + (i % 6)],
      'student', md5(i::text), '{"note":"load test"}'::jsonb, now() - ((${n} - i) * 40) * interval '1 second'
    FROM generate_series(1, ${n}) AS g(i)`);
}

const token = (email: string) => ({ token: `lt-${email}`, csrf: `lc-${email}` });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A signed-in session for every user of the big workspace, and fifty website credentials (see run.ts). */
async function access(tenant: string) {
  const users = await rows<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE tenant_id = '${tenant}' ORDER BY email`,
  );
  for (const u of users) {
    const t = token(u.email);
    await sql(`INSERT INTO sessions (id, user_id, token_hash, csrf_secret, mfa_verified, expires_at, last_seen_at, created_at)
      VALUES (gen_random_uuid(), '${u.id}', '${sha256(t.token)}', '${t.csrf}', true, now() + interval '7 days', now(), now())`);
  }
  for (let i = 1; i <= 50; i++) {
    const username = `wl_${String(i).padStart(12, '0')}`;
    await sql(`INSERT INTO intake_credentials (id, tenant_id, name, username, secret_hash, rate_limit_per_min, created_at)
      VALUES (gen_random_uuid(), '${tenant}', 'Load site ${i}', '${username}', '${sha256(`load-secret-${i}-0123456789abcdef`)}', 600, now())`);
  }
}

async function main() {
  const started = Date.now();
  let tenant: string;
  let admin: string;
  if (FROM === 0) {
    const existing = await rows<{ n: bigint }>(`SELECT count(*) AS n FROM tenants WHERE slug = 'bigco'`);
    if (Number(existing[0]!.n) > 0)
      throw new Error('bigco already exists. Use --from to add more, or run `pnpm load:down` to start over.');
    const hash = await hashPassword('Load-Test-Pass-2026-x');
    tenant = (
      await rows<{
        id: string;
      }>(`INSERT INTO tenants (id, name, slug, status, settings, created_at, updated_at)
      VALUES (gen_random_uuid(), 'Big Agency (load test)', 'bigco', 'ACTIVE', '{"roundRobin":true,"timezone":"Asia/Kolkata"}', now(), now()) RETURNING id`)
    )[0]!.id;
    console.log('Setting up the big workspace…');
    await sources(tenant);
    await users(tenant, 'bigco', { admin: 2, counselor: 60, telecaller: 88 }, hash);
    admin = (
      await rows<{ id: string }>(
        `SELECT id FROM users WHERE tenant_id = '${tenant}' AND role_code = 'TENANT_ADMIN' ORDER BY email LIMIT 1`,
      )
    )[0]!.id;
    await step('sessions and credentials', () => access(tenant));

    console.log(`Setting up ${SMALL} small workspaces…`);
    for (let k = 1; k <= SMALL; k++) {
      const slug = `small-${String(k).padStart(2, '0')}`;
      const id = (
        await rows<{
          id: string;
        }>(`INSERT INTO tenants (id, name, slug, status, settings, created_at, updated_at)
        VALUES (gen_random_uuid(), 'Small Agency ${k} (load test)', '${slug}', 'ACTIVE', '{"roundRobin":true}', now(), now()) RETURNING id`)
      )[0]!.id;
      await sources(id);
      await users(id, slug, { admin: 1, counselor: 3, telecaller: 4 }, hash);
      const a = (
        await rows<{ id: string }>(
          `SELECT id FROM users WHERE tenant_id = '${id}' AND role_code = 'TENANT_ADMIN' LIMIT 1`,
        )
      )[0]!.id;
      await leadsRangeQuiet(id, a, 6_100_000_000 + k * 1_000_000, 0, 10_000, 10_000);
    }
    console.log('Web leads and the audit log…');
    await step('web leads', () => webLeads(tenant, WEB_LEADS));
    await step('audit log', () => audit(tenant, admin, AUDIT));
  } else {
    const t = await rows<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'bigco'`);
    if (!t[0]) throw new Error('Run the first range (without --from) before adding more.');
    tenant = t[0].id;
    admin = (
      await rows<{ id: string }>(
        `SELECT id FROM users WHERE tenant_id = '${tenant}' AND role_code = 'TENANT_ADMIN' ORDER BY email LIMIT 1`,
      )
    )[0]!.id;
    const have = await rows<{ n: bigint }>(`SELECT count(*) AS n FROM leads WHERE tenant_id = '${tenant}'`);
    if (Number(have[0]!.n) !== FROM)
      throw new Error(`The workspace has ${have[0]!.n} leads but --from is ${FROM}.`);
  }

  console.log(`Big workspace: leads ${FROM + 1}–${TO} of ${TOTAL}…`);
  await leadsRange(tenant, admin, 6_000_000_000, FROM, TO, TOTAL);
  await step('ANALYZE', () => sql('ANALYZE'));
  const size = await rows<{ s: string; n: bigint }>(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS s, (SELECT count(*) FROM leads) AS n`,
  );
  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(0)} s. Database ${size[0]!.s}, ${size[0]!.n} leads in all.`,
  );
}

/** The small workspaces' rows, without a line per step. */
async function leadsRangeQuiet(
  tenant: string,
  admin: string,
  phoneBase: number,
  from: number,
  to: number,
  total: number,
) {
  const log = console.log;
  console.log = () => undefined;
  try {
    await leadsRange(tenant, admin, phoneBase, from, to, total);
  } finally {
    console.log = log;
  }
}

try {
  await main();
} finally {
  await db.$disconnect();
}
