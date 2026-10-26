/**
 * Times the lead list and dashboard services directly against the load database, with no web server in
 * between: `pnpm exec tsx scripts/loadtest/probe.ts`. For finding out which query is slow before a full
 * load run. Refuses any database that is not a `*_load` one.
 */
import { leads, reports } from '@avn-cms/core';
import { leadListQuerySchema } from '@avn-cms/core/schemas';
import { createClient } from '@avn-cms/db/testing';

const OWNER_URL =
  process.env['LOAD_DATABASE_OWNER_URL'] ??
  'postgresql://avn_owner:avn_owner_local_only@127.0.0.1:55460/avn_cms_load';
const APP_URL =
  process.env['LOAD_DATABASE_URL'] ?? 'postgresql://avn_app:avn_app_local_only@127.0.0.1:55460/avn_cms_load';
if (!/_load\b/.test(new URL(OWNER_URL).pathname))
  throw new Error('Refusing to probe a database that is not *_load.');

process.env['DATABASE_URL'] = APP_URL;
process.env['DATABASE_OWNER_URL'] = OWNER_URL;
process.env['REPORT_CACHE_SECONDS'] = '0';

const owner = createClient(OWNER_URL, { poolMax: 1, statementTimeoutMs: 120_000 });
const [bigco] = await owner.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM tenants WHERE slug = 'bigco'`);
const tenantId = bigco!.id;
const user = async (email: string) =>
  (
    await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM users WHERE tenant_id = '${tenantId}' AND email = '${email}'`,
    )
  )[0]!.id;
const admin = { tenantId, userId: await user('a001@bigco.test'), role: 'TENANT_ADMIN' as const };
const counselor = { tenantId, userId: await user('c007@bigco.test'), role: 'COUNSELOR' as const };

async function time(label: string, fn: () => Promise<unknown>, runs = 3) {
  const took: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    took.push(Math.round(performance.now() - t));
  }
  console.log(`${label.padEnd(54)} ${took.join(' ms, ')} ms`);
}

const list = (ctx: typeof admin | typeof counselor, q: Record<string, string>) =>
  leads.listLeads(ctx, leadListQuerySchema.parse({ limit: '50', ...q }));

await time('list: newest', () => list(admin, {}));
await time('list: search first name (Asha)', () => list(admin, { q: 'Asha' }));
await time('list: search phone digits (654321)', () => list(admin, { q: '654321' }));
await time('list: search first name, as a counselor', () => list(counselor, { q: 'Asha' }));
if (process.env['PROBE_ONE']) {
  await time('one: ' + process.env['PROBE_ONE'], () => list(admin, { q: process.env['PROBE_ONE']! }), 2);
  await owner.$disconnect();
  process.exit(0);
}
if (process.env['PROBE_NAMES']) {
  // Every first name the load test searches for: a common name must be quick whichever it is.
  for (const name of [
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
  ])
    await time(`list: first name ${name}`, () => list(admin, { q: name }), 2);
}
await time('list: filter by state', () => list(admin, { state: 'Telangana' }));
for (const view of ['unassigned', 'closed', 'overdue', 'today', 'potential', 'hot'])
  await time(`list: view=${view}, admin`, () => list(admin, { view }), 2);
await time('list: view=mine, counselor', () => list(counselor, { view: 'mine' }));
await time('list: view=overdue, counselor', () => list(counselor, { view: 'overdue' }));
await time('dashboard: admin (cold)', () => reports.dashboard(admin as never), 2);
await time('dashboard: counselor', () => reports.dashboard(counselor as never), 2);
await time('report: funnel, all time', () => reports.funnel(admin as never, {}), 2);
await time(
  'report: funnel, last 30 days',
  () =>
    reports.funnel(admin as never, {
      dateFrom: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
    }),
  2,
);
await time(
  'report: team, last 30 days',
  () =>
    reports.team(admin as never, {
      dateFrom: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
    }),
  2,
);
await time('report: sources, all time', () => reports.sources(admin as never, {}), 2);
await time('report: followups', () => reports.followupStats(admin as never, {}), 2);

await owner.$disconnect();
process.exit(0);
