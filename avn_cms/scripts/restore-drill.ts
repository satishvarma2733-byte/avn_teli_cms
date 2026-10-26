/**
 * Restore drill (docs/DEPLOYMENT.md §7, docs/RUNBOOK.md): proves a backup can really be restored.
 *
 *   pnpm restore:drill                                  # the load-test database (needs `pnpm load:up` and a seed)
 *   pnpm restore:drill --container avn-cms-dev-postgres-1 --db avn_cms \
 *       --owner-url postgresql://avn_owner:avn_owner_local_only@127.0.0.1:55450/avn_cms \
 *       --app-url   postgresql://avn_app:avn_app_local_only@127.0.0.1:55450/avn_cms
 *
 * What it does, the way an operator would: takes a custom-format dump of the database, copies the dump
 * out of the server (as an off-site copy would be), copies it back, restores it into a new database, then
 * checks that the restored copy is the same and still works as the application uses it:
 *  - every table has the same number of rows, and the same indexes, constraints, policies and functions;
 *  - the migration history is identical;
 *  - the application role can read its own workspace's rows through row-level security, and sees nothing
 *    without a workspace (so the policies and the grants survived the round trip);
 *  - the application role still cannot read password hashes.
 * It reports how long the dump and the restore took and how big the dump is, then drops the copy.
 *
 * Refuses to touch a database it did not create: the restored copy is always `<db>_restore_drill`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@avn-cms/db/testing';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const CONTAINER = arg('container', 'avn-cms-load-postgres-1');
const DB = arg('db', 'avn_cms_load');
const OWNER_URL = arg(
  'owner-url',
  'postgresql://avn_owner:avn_owner_local_only@127.0.0.1:55460/avn_cms_load',
);
const APP_URL = arg('app-url', 'postgresql://avn_app:avn_app_local_only@127.0.0.1:55460/avn_cms_load');
const OWNER = new URL(OWNER_URL).username;
const COPY = `${DB}_restore_drill`;
const swapDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

const docker = (args: string[], what: string) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const psql = (db: string, sql: string, what: string) =>
  docker(
    ['exec', CONTAINER, 'psql', '-U', OWNER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    what,
  ).trim();

const seconds = (since: number) => Math.round(((Date.now() - since) / 1000) * 10) / 10;
const results: Record<string, unknown> = { database: DB, at: new Date().toISOString() };
const problems: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const work = mkdtempSync(join(tmpdir(), 'avn-restore-drill-'));
const hostDump = join(work, 'backup.dump');
let source: ReturnType<typeof createClient> | undefined;
let copy: ReturnType<typeof createClient> | undefined;
let appCopy: ReturnType<typeof createClient> | undefined;

try {
  console.log(`Backing up "${DB}" in ${CONTAINER}…`);
  psql('postgres', `DROP DATABASE IF EXISTS "${COPY}"`, 'clean up an old copy');
  let t = Date.now();
  docker(
    ['exec', CONTAINER, 'pg_dump', '-U', OWNER, '-Fc', '-Z', '6', '-d', DB, '-f', '/tmp/drill.dump'],
    'pg_dump',
  );
  results['dumpSeconds'] = seconds(t);
  docker(['cp', `${CONTAINER}:/tmp/drill.dump`, hostDump], 'copy the backup out');
  const bytes = statSync(hostDump).size;
  results['dumpMegabytes'] = Math.round(bytes / 1024 / 1024);
  console.log(
    `  dump: ${results['dumpMegabytes']} MB in ${results['dumpSeconds']} s (copied off the server)`,
  );

  console.log(`Restoring into a new database "${COPY}"…`);
  docker(['cp', hostDump, `${CONTAINER}:/tmp/restore.dump`], 'copy the backup back');
  psql('postgres', `CREATE DATABASE "${COPY}" OWNER "${OWNER}"`, 'create the new database');
  t = Date.now();
  // Extensions first (the dump asks for them), then everything else, four jobs at a time.
  docker(
    [
      'exec',
      CONTAINER,
      'pg_restore',
      '-U',
      OWNER,
      '-d',
      COPY,
      '-j',
      '4',
      '--exit-on-error',
      '/tmp/restore.dump',
    ],
    'pg_restore',
  );
  results['restoreSeconds'] = seconds(t);
  console.log(`  restore: ${results['restoreSeconds']} s`);

  console.log('Checking the restored copy…');
  source = createClient(OWNER_URL, { poolMax: 2, statementTimeoutMs: 600_000 });
  copy = createClient(swapDb(OWNER_URL, COPY), { poolMax: 2, statementTimeoutMs: 600_000 });
  appCopy = createClient(swapDb(APP_URL, COPY), { poolMax: 2, statementTimeoutMs: 600_000 });

  const tables = (
    await source.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )
  ).map((r) => r.tablename);
  const counts = async (db: typeof source) => {
    const out: Record<string, number> = {};
    for (const name of tables) {
      const r = await db!.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${name}"`);
      out[name] = Number(r[0]!.n);
    }
    return out;
  };
  const [a, b] = [await counts(source), await counts(copy)];
  const differing = tables.filter((n) => a[n] !== b[n]);
  const total = Object.values(a).reduce((x, y) => x + y, 0);
  check(
    `all ${tables.length} tables have the same rows`,
    differing.length === 0,
    `${total.toLocaleString('en-IN')} rows in all${differing.length ? `; differ: ${differing.join(', ')}` : ''}`,
  );
  results['tables'] = tables.length;
  results['rows'] = total;

  const shape = async (db: typeof source) =>
    (
      await db!.$queryRawUnsafe<{ what: string; n: bigint }[]>(
        `SELECT 'indexes' AS what, count(*) AS n FROM pg_indexes WHERE schemaname = 'public'
         UNION ALL SELECT 'constraints', count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
         UNION ALL SELECT 'policies', count(*) FROM pg_policies WHERE schemaname = 'public'
         UNION ALL SELECT 'rls tables', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         UNION ALL SELECT 'functions', count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
         UNION ALL SELECT 'extensions', count(*) FROM pg_extension
         UNION ALL SELECT 'enum types', count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'`,
      )
    ).map((r) => `${r.what}=${Number(r.n)}`);
  const [sa, sb] = [await shape(source), await shape(copy)];
  check(
    'indexes, constraints, policies, functions and types are the same',
    JSON.stringify(sa) === JSON.stringify(sb),
    sa.join(' '),
  );

  const migrations = async (db: typeof source) =>
    (
      await db!.$queryRawUnsafe<{ migration_name: string }[]>(
        `SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`,
      )
    ).map((r) => r.migration_name);
  const [ma, mb] = [await migrations(source), await migrations(copy)];
  check(
    'the migration history is identical',
    JSON.stringify(ma) === JSON.stringify(mb),
    `${ma.length} migrations, last ${ma.at(-1)}`,
  );

  // The application's view: row-level security and column privileges survive the round trip.
  const tenant = (
    await source.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM tenants ORDER BY (SELECT count(*) FROM leads l WHERE l.tenant_id = tenants.id) DESC LIMIT 1`,
    )
  )[0]!.id;
  const expected = Number(
    (
      await source.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM leads WHERE tenant_id = '${tenant}'`,
      )
    )[0]!.n,
  );
  const seen = await appCopy.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenant}', true)`);
    return Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM leads`))[0]!.n);
  });
  check(
    'the application role reads its own workspace through row-level security',
    seen === expected,
    `${seen.toLocaleString('en-IN')} leads`,
  );
  const unscoped = Number(
    (await appCopy.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM leads`))[0]!.n,
  );
  check('and sees nothing when no workspace is set', unscoped === 0);
  const credentials = await appCopy.$queryRawUnsafe(`SELECT password_hash FROM users LIMIT 1`).then(
    () => false,
    () => true,
  );
  check('and still cannot read password hashes', credentials);

  results['ok'] = problems.length === 0;
  console.log(
    problems.length === 0
      ? '\nThe backup restored, and the copy matches.'
      : `\n${problems.length} check(s) failed.`,
  );
} finally {
  await Promise.allSettled([source?.$disconnect(), copy?.$disconnect(), appCopy?.$disconnect()]);
  try {
    psql('postgres', `DROP DATABASE IF EXISTS "${COPY}"`, 'drop the copy');
    docker(['exec', CONTAINER, 'rm', '-f', '/tmp/drill.dump', '/tmp/restore.dump'], 'remove the dump files');
  } catch (err) {
    console.error(`Clean-up problem: ${err instanceof Error ? err.message : String(err)}`);
  }
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
process.exit(problems.length === 0 ? 0 : 1);
