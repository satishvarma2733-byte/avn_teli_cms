import { randomUUID } from 'node:crypto';

import { hashPassword } from '@avn-cms/auth';
import type { RoleCode } from '@avn-cms/db';
import { ownerDb } from '@avn-cms/db/owner';
import { truncateAll } from '@avn-cms/db/testing';

/** Test fixtures, written with the owner client (bypasses RLS). TEST DATA ONLY. */

export const TEST_PASSWORD = 'Test-Password-123';
let cachedHash: string | undefined;
const passwordHash = async () => (cachedHash ??= await hashPassword(TEST_PASSWORD));

export async function resetData(): Promise<void> {
  await truncateAll(ownerDb());
}

export async function makeTenant(
  slug = `t-${randomUUID().slice(0, 8)}`,
  status: 'ACTIVE' | 'SUSPENDED' | 'TRIAL' = 'ACTIVE',
) {
  const db = ownerDb();
  const tenant = await db.tenant.create({ data: { slug, name: `Tenant ${slug}`, status } });
  await db.leadSource.createMany({
    data: [
      ['WEBSITE', 'Website'],
      ['GOOGLE_ADS', 'Google Ads'],
      ['DIRECT_CALL', 'Direct Call'],
      ['OTHER', 'Other'],
    ].map(([code, label]) => ({ tenantId: tenant.id, code: code!, label: label! })),
  });
  return tenant;
}

export async function makeUser(tenantId: string | null, roleCode: RoleCode, email?: string) {
  return ownerDb().user.create({
    data: {
      tenantId,
      roleCode,
      name: `${roleCode.toLowerCase()} user`,
      email: email ?? `${roleCode.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`,
      passwordHash: await passwordHash(),
    },
  });
}

let phoneSeq = 0;
export function nextPhone(): string {
  phoneSeq += 1;
  return `+9190000${String(10_000 + phoneSeq).slice(-5)}`;
}

/** A student with one lead, optionally assigned. */
export async function makeLead(
  tenantId: string,
  opts: {
    counselorId?: string;
    telecallerId?: string;
    name?: string;
    stage?: 'NEW' | 'CONTACTED' | 'ENROLLED';
  } = {},
) {
  const db = ownerDb();
  const source = await db.leadSource.findFirstOrThrow({ where: { tenantId, code: 'WEBSITE' } });
  const phone = nextPhone();
  const student = await db.student.create({
    data: { tenantId, name: opts.name ?? 'Test Student', phoneRaw: phone, phoneE164: phone },
  });
  const lead = await db.lead.create({
    data: { tenantId, studentId: student.id, sourceId: source.id, stage: opts.stage ?? 'NEW' },
  });
  if (opts.counselorId) {
    await db.leadAssignment.create({
      data: { tenantId, leadId: lead.id, assigneeId: opts.counselorId, roleFunction: 'COUNSELOR' },
    });
  }
  if (opts.telecallerId) {
    await db.leadAssignment.create({
      data: { tenantId, leadId: lead.id, assigneeId: opts.telecallerId, roleFunction: 'TELECALLER' },
    });
  }
  return { student, lead };
}
