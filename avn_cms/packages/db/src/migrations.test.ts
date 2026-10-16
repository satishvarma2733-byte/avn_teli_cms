import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TENANT_MODELS } from './tenant';

/**
 * Guards for hand-written SQL that Prisma can't model. Prisma's migration generator tries to
 * DROP indexes it doesn't know about (e.g. NULLS NOT DISTINCT uniques), and new tenant tables
 * need RLS added by hand. Both mistakes would be silent at runtime.
 */
const dir = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const migrations = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const sqlOf = (name: string) => readFileSync(`${dir}${name}/migration.sql`, 'utf8');
const allSql = migrations.map(sqlOf).join('\n');

const PROTECTED_INDEXES = [
  'users_tenant_email_key',
  'students_tenant_phone_active_key',
  'lead_assignments_active_key',
  'web_leads_idempotency_key',
  'students_name_trgm',
  'students_phone_trgm',
];

describe('migrations', () => {
  it('never drop the hand-written indexes', () => {
    for (const name of migrations) {
      const sql = sqlOf(name).replace(/--.*$/gm, '');
      for (const idx of PROTECTED_INDEXES) {
        expect(sql, `${name} drops ${idx}`).not.toMatch(new RegExp(`DROP INDEX[^;]*"${idx}"`));
      }
    }
  });

  it('enable row-level security on every tenant-owned table', () => {
    const schema = readFileSync(fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url)), 'utf8');
    const tableOf = (model: string) => {
      const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema)?.[1] ?? '';
      return /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? model;
    };
    for (const model of TENANT_MODELS) {
      const table = tableOf(model);
      const inLoop = new RegExp(`'${table}'`).test(allSql.slice(allSql.indexOf('FOREACH t IN ARRAY')));
      const direct = new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`).test(allSql);
      expect(inLoop || direct, `${model} (${table}) has no RLS`).toBe(true);
    }
  });
});
