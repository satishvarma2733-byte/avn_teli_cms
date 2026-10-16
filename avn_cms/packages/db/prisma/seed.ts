/**
 * Local/demo seed. Everything created here is TEST DATA: fictional names, +91 90000 phone
 * numbers and *.test emails. Refuses to run in production and refuses to run twice.
 *
 *   pnpm db:seed                 → demo tenant + users + ~40 students/leads
 *   SEED_PASSWORD=… pnpm db:seed → choose the demo users' password (default in .env.example)
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hash } from '@node-rs/argon2';

import { createClient } from '../src/client';
import type { CallDisposition, LeadStage, PlanCode, RoleCode } from '../generated/prisma/enums';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

if (process.env['NODE_ENV'] === 'production') throw new Error('The demo seed never runs in production.');
const ownerUrl = process.env['SEED_DATABASE_OWNER_URL'] ?? process.env['DATABASE_OWNER_URL'];
if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is not set');
const password = process.env['SEED_PASSWORD'];
if (!password || password.length < 12) throw new Error('Set SEED_PASSWORD (12+ characters) in .env');

// Same parameters as packages/auth/src/password.ts (OWASP Argon2id baseline; Argon2id is the default algorithm).
const hashPassword = (p: string) => hash(p, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });

const db = createClient(ownerUrl, { poolMax: 2 });

const PLANS: { code: PlanCode; name: string; limits: object; priceMinor: number }[] = [
  {
    code: 'STARTER',
    name: 'Starter',
    limits: { max_users: 3, max_leads: 5_000, storage_mb: 1_024 },
    priceMinor: 0,
  },
  {
    code: 'PROFESSIONAL',
    name: 'Professional',
    limits: { max_users: 15, max_leads: 50_000, storage_mb: 10_240 },
    priceMinor: 499_900,
  },
  {
    code: 'ULTRA',
    name: 'Ultra',
    limits: { max_users: 50, max_leads: 250_000, storage_mb: 51_200 },
    priceMinor: 1_499_900,
  },
  {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    limits: { max_users: null, max_leads: null, storage_mb: null },
    priceMinor: 0,
  },
];

const ROLES: { code: RoleCode; name: string }[] = [
  { code: 'SUPER_ADMIN', name: 'Super Admin' },
  { code: 'TENANT_ADMIN', name: 'Tenant Admin' },
  { code: 'COUNSELOR', name: 'Counselor' },
  { code: 'TELECALLER', name: 'Telecaller' },
];

export const DEFAULT_SOURCES = [
  ['SHEET_DATA', 'Sheet Data'],
  ['GOOGLE_ADS', 'Google Ads'],
  ['META_ADS', 'Meta Ads'],
  ['DIRECT_CALL', 'Direct Call'],
  ['REFERENCE', 'Reference'],
  ['WEBSITE', 'Website'],
  ['WALK_IN', 'Walk-in'],
  ['OTHER', 'Other'],
] as const;

const FIRST = [
  'Aarav',
  'Diya',
  'Vihaan',
  'Ananya',
  'Ishaan',
  'Saanvi',
  'Arjun',
  'Meera',
  'Kabir',
  'Riya',
  'Rohan',
  'Kavya',
  'Aditya',
  'Sneha',
  'Karthik',
  'Pooja',
  'Rahul',
  'Lakshmi',
  'Nikhil',
  'Divya',
];
const LAST = ['Reddy', 'Sharma', 'Rao', 'Naidu', 'Iyer', 'Varma', 'Kumar', 'Patel', 'Menon', 'Gupta'];
const PLACES = [
  ['Guntur', 'Guntur', 'Andhra Pradesh'],
  ['Vijayawada', 'NTR', 'Andhra Pradesh'],
  ['Warangal', 'Hanamkonda', 'Telangana'],
  ['Hyderabad', 'Hyderabad', 'Telangana'],
  ['Nellore', 'SPSR Nellore', 'Andhra Pradesh'],
  ['Karimnagar', 'Karimnagar', 'Telangana'],
] as const;
const COUNTRIES = ['Kyrgyzstan', 'Georgia', 'Russia', 'Kazakhstan', 'Uzbekistan', 'Philippines'];
const STAGES: LeadStage[] = [
  'NEW',
  'NEW',
  'NEW',
  'CONTACTED',
  'CONTACTED',
  'INTERESTED',
  'FOLLOW_UP_REQUIRED',
  'POTENTIAL',
  'APPLICATION_STARTED',
  'DOCUMENTS_PENDING',
  'APPLICATION_SUBMITTED',
  'OFFER_RECEIVED',
  'ADMISSION_CONFIRMED',
  'ENROLLED',
  'NOT_INTERESTED',
  'UNREACHABLE',
  'LONG_TERM',
];
const DISPOSITIONS: CallDisposition[] = [
  'COMPLETED',
  'NO_ANSWER',
  'BUSY',
  'CALL_BACK_LATER',
  'INTERESTED',
  'AWAITING_FEEDBACK',
];

const pick = <T>(arr: readonly T[], i: number): T => arr[i % arr.length] as T;
/** FOLLOW_UP_REQUIRED → "Follow up required" (matches how the app words timeline entries). */
const humanize = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

async function main() {
  if (await db.tenant.findUnique({ where: { slug: 'demo' } })) {
    console.log('Seed skipped: tenant "demo" already exists.');
    return;
  }

  for (const p of PLANS) await db.plan.upsert({ where: { code: p.code }, update: {}, create: p });
  for (const r of ROLES) await db.role.upsert({ where: { code: r.code }, update: {}, create: r });
  const professional = await db.plan.findUniqueOrThrow({ where: { code: 'PROFESSIONAL' } });

  const passwordHash = await hashPassword(password!);

  await db.user.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: null,
      roleCode: 'SUPER_ADMIN',
      name: 'Platform Admin (test)',
      email: 'superadmin@avn-cms.test',
      passwordHash,
    },
  });

  await seedTenant({
    slug: 'demo',
    name: 'Demo Agency (test data)',
    planId: professional.id,
    passwordHash,
    students: 40,
    staff: [
      ['TENANT_ADMIN', 'Asha Admin', 'admin@demo.test'],
      ['COUNSELOR', 'Chaitanya Counselor', 'counselor1@demo.test'],
      ['COUNSELOR', 'Charitha Counselor', 'counselor2@demo.test'],
      ['TELECALLER', 'Teja Telecaller', 'telecaller1@demo.test'],
      ['TELECALLER', 'Tara Telecaller', 'telecaller2@demo.test'],
    ],
  });
  await seedTenant({
    slug: 'other',
    name: 'Other Agency (test data)',
    planId: professional.id,
    passwordHash,
    students: 5,
    staff: [
      ['TENANT_ADMIN', 'Omar Admin', 'admin@other.test'],
      ['COUNSELOR', 'Olivia Counselor', 'counselor@other.test'],
    ],
  });
  console.log(
    'Seed complete: tenants "demo" and "other" (test data), platform admin superadmin@avn-cms.test.',
  );
}

async function seedTenant(opts: {
  slug: string;
  name: string;
  planId: string;
  passwordHash: string;
  students: number;
  staff: [RoleCode, string, string][];
}) {
  const tenant = await db.tenant.create({
    data: {
      slug: opts.slug,
      name: opts.name,
      status: 'ACTIVE',
      planId: opts.planId,
      settings: { timezone: 'Asia/Kolkata', roundRobin: true },
    },
  });
  const t = tenant.id;
  await db.subscription.create({
    data: { tenantId: t, planId: opts.planId, periodStart: new Date(), periodEnd: hoursFromNow(24 * 30) },
  });
  await db.leadSource.createMany({
    data: DEFAULT_SOURCES.map(([code, label]) => ({ tenantId: t, code, label })),
  });
  const sources = await db.leadSource.findMany({ where: { tenantId: t } });

  const users = [];
  for (const [roleCode, name, email] of opts.staff) {
    users.push(
      await db.user.create({ data: { tenantId: t, roleCode, name, email, passwordHash: opts.passwordHash } }),
    );
  }
  const admin = users.find((u) => u.roleCode === 'TENANT_ADMIN')!;
  const counselors = users.filter((u) => u.roleCode === 'COUNSELOR');
  const telecallers = users.filter((u) => u.roleCode === 'TELECALLER');
  const prefix = opts.slug === 'demo' ? '90000' : '90001';

  for (let i = 0; i < opts.students; i++) {
    const [town, district, state] = pick(PLACES, i);
    const phone = `+91${prefix}${String(10_000 + i).slice(-5)}`;
    const name = `${pick(FIRST, i)} ${pick(LAST, i * 3)}`;
    const createdAt = hoursFromNow(-24 * (opts.students - i) - (i % 7));
    const student = await db.student.create({
      data: {
        tenantId: t,
        name,
        parentName: `${pick(FIRST, i + 5)} ${pick(LAST, i * 3)}`,
        phoneRaw: phone.slice(3),
        phoneE164: phone,
        email: i % 3 === 0 ? null : `${name.split(' ')[0]!.toLowerCase()}${i}@example.test`,
        town,
        district,
        state,
        createdById: admin.id,
        createdAt,
      },
    });
    const stage = pick(STAGES, i);
    const counselor = counselors.length ? pick(counselors, i) : admin;
    const telecaller = telecallers.length ? pick(telecallers, i) : null;
    const lead = await db.lead.create({
      data: {
        tenantId: t,
        studentId: student.id,
        sourceId: pick(sources, i).id,
        stage,
        isPotential: stage === 'POTENTIAL' || i % 9 === 0,
        priority: i % 6 === 0 ? 'HOT' : 'NORMAL',
        interestCountry: pick(COUNTRIES, i),
        interestCourse: 'MBBS',
        createdAt,
        lastContactedAt: stage === 'NEW' ? null : hoursFromNow(-24 - i),
      },
    });
    await db.leadStatusHistory.create({
      data: {
        tenantId: t,
        leadId: lead.id,
        fromStage: null,
        toStage: 'NEW',
        changedById: admin.id,
        createdAt,
      },
    });
    if (stage !== 'NEW') {
      await db.leadStatusHistory.create({
        data: { tenantId: t, leadId: lead.id, fromStage: 'NEW', toStage: stage, changedById: counselor.id },
      });
      await db.activity.create({
        data: {
          tenantId: t,
          leadId: lead.id,
          studentId: student.id,
          type: 'STATUS_CHANGE',
          actorId: counselor.id,
          summary: `Stage changed from New to ${humanize(stage)}`,
          payload: { from: 'NEW', to: stage },
        },
      });
    }
    await db.leadAssignment.create({
      data: {
        tenantId: t,
        leadId: lead.id,
        assigneeId: counselor.id,
        roleFunction: 'COUNSELOR',
        assignedById: admin.id,
      },
    });
    if (telecaller) {
      await db.leadAssignment.create({
        data: {
          tenantId: t,
          leadId: lead.id,
          assigneeId: telecaller.id,
          roleFunction: 'TELECALLER',
          assignedById: admin.id,
        },
      });
    }
    // Follow-ups spread across today / overdue / upcoming / closed.
    const caller = telecaller ?? counselor;
    const slot = i % 4;
    const scheduledAt =
      slot === 0
        ? hoursFromNow(1 + (i % 5))
        : slot === 1
          ? hoursFromNow(-30 - i)
          : slot === 2
            ? hoursFromNow(48 + i)
            : hoursFromNow(-72);
    const done = slot === 3;
    await db.followUp.create({
      data: {
        tenantId: t,
        leadId: lead.id,
        assigneeId: caller.id,
        scheduledAt,
        disposition: done ? pick(DISPOSITIONS, i) : 'SCHEDULED',
        completedAt: done ? hoursFromNow(-71) : null,
        outcomeNote: done ? 'Spoke with parent; sharing fee details (test data).' : null,
        isOverdue: slot === 1,
        priority: i % 6 === 0 ? 'HOT' : 'NORMAL',
        createdById: counselor.id,
      },
    });
    if (!done) await db.lead.updateMany({ where: { id: lead.id }, data: { nextCallAt: scheduledAt } });
    if (done) {
      await db.activity.create({
        data: {
          tenantId: t,
          leadId: lead.id,
          studentId: student.id,
          type: 'CALL',
          actorId: caller.id,
          direction: 'OUT',
          summary: `Call: ${humanize(pick(DISPOSITIONS, i))}`,
          payload: { disposition: pick(DISPOSITIONS, i) },
        },
      });
    }
  }
}

try {
  await main();
} finally {
  await db.$disconnect();
}
