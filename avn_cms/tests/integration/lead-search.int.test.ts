import { leads } from '@avn-cms/core';
import { appDb, withTenant } from '@avn-cms/db';
import { ownerDb } from '@avn-cms/db/owner';
import { beforeAll, describe, expect, it } from 'vitest';

import { ctxFor } from '../fixtures/ctx';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

/**
 * Lead search and totals as built for a million leads (docs/SCALABILITY.md §4): the matching runs in
 * `search_student_ids` (so the trigram indexes work under row-level security), a state filter ignores
 * case, and the total stops counting at 1,000.
 */
describe('lead search and totals', () => {
  let tenant: { id: string };
  let other: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let counselor: Awaited<ReturnType<typeof makeUser>>;
  let telecaller: Awaited<ReturnType<typeof makeUser>>;
  let otherAdmin: Awaited<ReturnType<typeof makeUser>>;

  const search = async (who: typeof admin, q: string, extra: Record<string, unknown> = {}) =>
    leads.listLeads(ctxFor(who), { view: 'all', sort: 'newest', limit: 50, q, ...extra } as never);
  const names = (r: Awaited<ReturnType<typeof search>>) => r.items.map((i) => i.student.name).sort();

  beforeAll(async () => {
    await resetData();
    tenant = await makeTenant('srch');
    other = await makeTenant('srch-other');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    counselor = await makeUser(tenant.id, 'COUNSELOR');
    telecaller = await makeUser(tenant.id, 'TELECALLER');
    otherAdmin = await makeUser(other.id, 'TENANT_ADMIN');

    const db = ownerDb();
    const named = async (tenantId: string, name: string, patch: object = {}, opts = {}) => {
      const made = await makeLead(tenantId, { name, ...opts });
      if (Object.keys(patch).length) await db.student.update({ where: { id: made.student.id }, data: patch });
      return made;
    };
    await named(tenant.id, 'Aarav Sharma', { parentName: 'Rohit Verma' }, { counselorId: counselor.id });
    await named(tenant.id, 'Meera 50% Off', { email: 'meera@mail.test' }, { counselorId: counselor.id });
    await named(tenant.id, 'Under_score Kid');
    await named(tenant.id, 'Tanvi Rao', { state: 'Telangana' });
    await named(tenant.id, 'Tarun Rao', { state: 'telangana' });
    await named(tenant.id, 'Tejas Rao', { state: 'TELANGANA' });
    await named(tenant.id, 'Tilak Rao', { state: 'Kerala' });
    await named(other.id, 'Aarav Sharma', { parentName: 'Rohit Verma' });
  });

  it('finds students by name, parent’s name and phone digits, in the person’s own workspace only', async () => {
    expect(names(await search(admin, 'aarav'))).toEqual(['Aarav Sharma']);
    expect(names(await search(admin, 'rohit'))).toEqual(['Aarav Sharma']);
    const meera = await ownerDb().student.findFirstOrThrow({
      where: { tenantId: tenant.id, name: 'Meera 50% Off' },
    });
    const digits = meera.phoneE164.slice(-6);
    expect(names(await search(admin, digits))).toEqual(['Meera 50% Off']);
    // The other agency's "Aarav Sharma" never shows up here, nor ours there.
    expect((await search(otherAdmin, 'aarav')).items).toHaveLength(1);
    expect((await search(otherAdmin, 'aarav')).items[0]!.id).not.toBe(
      (await search(admin, 'aarav')).items[0]!.id,
    );
    expect((await search(otherAdmin, 'meera')).items).toHaveLength(0);
  });

  it('keeps counselors to their own leads, searching or not', async () => {
    expect(names(await search(counselor, 'aarav'))).toEqual(['Aarav Sharma']);
    expect((await search(counselor, 'tanvi')).items).toHaveLength(0);
  });

  it('reads % and _ in the search as ordinary characters', async () => {
    expect(names(await search(admin, '50%'))).toEqual(['Meera 50% Off']);
    expect(names(await search(admin, '%'))).toEqual(['Meera 50% Off']);
    // As a wildcard, "e_r" would match the "eer" in Meera.
    expect(names(await search(admin, 'e_r'))).toEqual([]);
    expect(names(await search(admin, '_score'))).toEqual(['Under_score Kid']);
  });

  it('searches the email only when it looks like one, and not for telecallers', async () => {
    expect(names(await search(admin, 'meera@mail'))).toEqual(['Meera 50% Off']);
    expect(names(await search(telecaller, 'meera@mail'))).toEqual([]);
  });

  it('does not find a student who has been deleted', async () => {
    const gone = await makeLead(tenant.id, { name: 'Zed Deleted' });
    expect(names(await search(admin, 'zed deleted'))).toEqual(['Zed Deleted']);
    await leads.deleteStudent(ctxFor(admin), gone.student.id);
    expect(names(await search(admin, 'zed deleted'))).toEqual([]);
  });

  it('ignores case in the state filter, whichever way it is spelled in the data', async () => {
    for (const asked of ['Telangana', 'telangana', 'TELANGANA']) {
      const r = await leads.listLeads(ctxFor(admin), {
        view: 'all',
        sort: 'newest',
        limit: 50,
        state: asked,
      } as never);
      expect(names(r)).toEqual(['Tanvi Rao', 'Tarun Rao', 'Tejas Rao']);
    }
  });

  describe('the database function', () => {
    const ids = (tenantId: string, term: string, digits = '', email = false) =>
      withTenant(tenantId, async (db) => {
        const rows = await db.$queryRaw<{ id: string }[]>`
          SELECT search_student_ids(${term}, ${digits}, ${email}, ${100}) AS id`;
        return rows.map((r) => r.id);
      });

    it('returns only the workspace it is run for, and nothing when none is set', async () => {
      const mine = await ids(tenant.id, 'aarav');
      const theirs = await ids(other.id, 'aarav');
      expect(mine).toHaveLength(1);
      expect(theirs).toHaveLength(1);
      expect(mine[0]).not.toBe(theirs[0]);
      // Straight on the application connection, no workspace set: nothing, however broad the search.
      const bare = await appDb().$queryRaw<
        { id: string }[]
      >`SELECT search_student_ids('a', '', false, 100) AS id`;
      expect(bare).toEqual([]);
    });

    it('is for the application role only', async () => {
      const [row] = await ownerDb().$queryRaw<{ app: boolean; anyone: boolean }[]>`
        SELECT has_function_privilege('avn_app', 'search_student_ids(text,text,boolean,integer)', 'EXECUTE') AS app,
               has_function_privilege('public', 'search_student_ids(text,text,boolean,integer)', 'EXECUTE') AS anyone`;
      expect(row).toEqual({ app: true, anyone: false });
    });

    it('treats a search made of SQL as plain text', async () => {
      expect(await ids(tenant.id, `'; DROP TABLE students; --`)).toEqual([]);
      expect(await ids(tenant.id, `a' OR '1'='1`)).toEqual([]);
      expect(await ownerDb().student.count({ where: { tenantId: tenant.id } })).toBeGreaterThan(5);
    });
  });

  describe('with a lot of leads', () => {
    beforeAll(async () => {
      const db = ownerDb();
      const source = await db.leadSource.findFirstOrThrow({ where: { tenantId: tenant.id } });
      // 2,100 more students called "Crowd N", all of them leads, so one search matches more than the
      // function lists (2,000) and the list has more than the 1,000 it counts.
      await db.$executeRawUnsafe(`
        INSERT INTO students (id, tenant_id, name, phone_raw, phone_e164, created_at, updated_at)
        SELECT md5('crowd' || i)::uuid, '${tenant.id}'::uuid, 'Crowd ' || i, (8000000000 + i)::text, '+91' || (8000000000 + i)::text,
               now() - (i || ' seconds')::interval, now()
        FROM generate_series(1, 2100) AS i`);
      await db.$executeRawUnsafe(`
        INSERT INTO leads (id, tenant_id, student_id, source_id, stage, created_at, updated_at)
        SELECT gen_random_uuid(), '${tenant.id}'::uuid, s.id, '${source.id}'::uuid, 'NEW', s.created_at, now()
        FROM students s WHERE s.tenant_id = '${tenant.id}'::uuid AND s.name LIKE 'Crowd %'`);
    });

    it('answers a search that matches thousands, newest first, with a total that stops at 1,000', async () => {
      const r = await search(admin, 'Crowd');
      expect(r.items).toHaveLength(50);
      expect(r.items[0]!.student.name).toBe('Crowd 1'); // the newest
      expect(r.total).toBe(1000);
      expect(r.totalExact).toBe(false);
      expect(r.nextCursor).not.toBeNull();
    });

    it('still finds one student among them by number, exactly', async () => {
      const r = await search(admin, 'Crowd 2077');
      expect(names(r)).toEqual(['Crowd 2077']);
      expect(r.total).toBe(1);
      expect(r.totalExact).toBe(true);
    });

    it('gives the exact total when the filter keeps it under 1,000', async () => {
      const r = await leads.listLeads(ctxFor(admin), {
        view: 'all',
        sort: 'newest',
        limit: 10,
        state: 'kerala',
      } as never);
      expect(r.total).toBe(1);
      expect(r.totalExact).toBe(true);
      const all = await leads.listLeads(ctxFor(admin), { view: 'all', sort: 'newest', limit: 10 } as never);
      expect(all.total).toBe(1000);
      expect(all.totalExact).toBe(false);
    });

    it('counts the rows on the page when everything fits on it', async () => {
      const r = await search(admin, 'rao', { limit: 50 });
      expect(r.total).toBe(r.items.length);
      expect(r.totalExact).toBe(true);
    });
  });
});
