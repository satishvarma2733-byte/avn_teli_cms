import { appDb, TenantScopeViolation, withTenant } from '@avn-cms/db';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeLead, makeTenant, resetData } from '../fixtures/factory';

/**
 * Tenant isolation (Phase 1 exit criterion): cross-tenant queries return nothing, through
 * both layers — the scoped client and Postgres RLS on the avn_app role.
 */
describe('tenant isolation', () => {
  let a: { id: string };
  let b: { id: string };
  let leadB: { id: string };
  let studentB: { id: string };

  beforeAll(async () => {
    await resetData();
    a = await makeTenant('tenant-a');
    b = await makeTenant('tenant-b');
    await makeLead(a.id, { name: 'Alice A' });
    const made = await makeLead(b.id, { name: 'Bob B' });
    leadB = made.lead;
    studentB = made.student;
  });

  it('scoped client only returns the current tenant', async () => {
    const names = await withTenant(a.id, (db) => db.student.findMany({ select: { name: true } }));
    expect(names.map((s) => s.name)).toEqual(['Alice A']);
  });

  it('a filter naming another tenant id still returns nothing', async () => {
    const rows = await withTenant(a.id, (db) => db.lead.findMany({ where: { tenantId: b.id } }));
    expect(rows).toEqual([]);
    const byId = await withTenant(a.id, (db) => db.lead.findFirst({ where: { id: leadB.id } }));
    expect(byId).toBeNull();
  });

  it('cannot update or delete another tenant’s rows', async () => {
    const updated = await withTenant(a.id, (db) =>
      db.student.updateMany({ where: { id: studentB.id }, data: { name: 'pwned' } }),
    );
    expect(updated.count).toBe(0);
    const deleted = await withTenant(a.id, (db) => db.note.deleteMany({ where: { leadId: leadB.id } }));
    expect(deleted.count).toBe(0);
  });

  it('refuses to create a row for another tenant', async () => {
    await expect(
      withTenant(a.id, (db) =>
        db.student.create({ data: { tenantId: b.id, name: 'x', phoneRaw: '1', phoneE164: '+911' } }),
      ),
    ).rejects.toBeInstanceOf(TenantScopeViolation);
  });

  it('refuses unique-key operations that cannot be scoped', async () => {
    await expect(
      withTenant(a.id, (db) => db.lead.findUnique({ where: { id: leadB.id } })),
    ).rejects.toBeInstanceOf(TenantScopeViolation);
  });

  describe('RLS backstop (raw SQL as avn_app)', () => {
    it('sees no tenant rows when app.tenant_id is unset', async () => {
      const rows = await appDb().$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM students`;
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('raw SQL inside a tenant transaction still only sees that tenant', async () => {
      const rows = await withTenant(
        a.id,
        (db) => db.$queryRaw<{ name: string }[]>`SELECT name FROM students`,
      );
      expect(rows.map((r) => r.name)).toEqual(['Alice A']);
    });

    it('raw INSERT for another tenant is rejected by the policy', async () => {
      await expect(
        withTenant(
          a.id,
          (db) =>
            db.$executeRaw`INSERT INTO students (id, tenant_id, name, phone_raw, phone_e164, updated_at)
                         VALUES (gen_random_uuid(), ${b.id}::uuid, 'x', '1', '+910000000001', now())`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('the app role cannot touch sessions or rewrite the audit log', async () => {
      await expect(appDb().$queryRaw`SELECT * FROM sessions`).rejects.toThrow(/permission denied/i);
      await expect(withTenant(a.id, (db) => db.$executeRaw`DELETE FROM audit_logs`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        withTenant(a.id, (db) => db.$executeRaw`UPDATE activities SET summary = 'x'`),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
