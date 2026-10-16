/**
 * Smoke test for the LeadXP-compatible intake over real HTTP.
 *
 *   # local: creates a temporary credential for a tenant, posts both eWings payload shapes,
 *   # checks the responses and the stored rows, then revokes the credential.
 *   pnpm smoke:webleads --url http://localhost:3300 --tenant demo
 *
 *   # any environment: use an existing credential (created in Settings → Website integrations).
 *   SMOKE_USERNAME=wl_… SMOKE_SECRET=… pnpm smoke:webleads --url https://staging.example
 *
 * Posts TEST DATA only (fictional name, +91 90009 numbers, example.test email). Never point
 * it at a production tenant without approval: it creates real web-lead rows.
 */
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const baseUrl = (arg('url') ?? 'http://localhost:3300').replace(/\/$/, '');
const tenantSlug = arg('tenant');

const suffix = String(Math.floor(10_000 + Math.random() * 89_999));
const mainSite = {
  name: 'Smoke Test Student',
  mobile: `90009${suffix}`,
  email: 'smoke@example.test',
  message: 'Smoke test — please ignore',
  parent_student: 'Student',
  education: null,
  group: 'BiPC',
  neet_status: null,
  neet_score: 450,
  preferred_country: 'Georgia',
  google_click_id: null,
  campaign_id: null,
  source: 'Landing Page',
};
const blog = {
  name: 'Smoke Blog Reader',
  phone: `+91 90009 ${suffix.slice(0, 2)}${String(Number(suffix.slice(2)) + 1).padStart(3, '0')}`,
  city: 'Guntur',
  neetScore: '401',
  source: 'blog_inline_cta',
  postSlug: 'smoke-test',
};

let created: { id: string; tenantId: string } | null = null;
let username = process.env['SMOKE_USERNAME'];
let secret = process.env['SMOKE_SECRET'];

async function setupCredential() {
  if (username && secret) return;
  if (!tenantSlug) throw new Error('Pass --tenant <slug> (local) or set SMOKE_USERNAME and SMOKE_SECRET');
  const { createHash } = await import('node:crypto');
  const { ownerDb } = await import('@avn-cms/db/owner');
  const tenant = await ownerDb().tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) throw new Error(`No tenant "${tenantSlug}"`);
  username = `wl_${randomBytes(6).toString('hex')}`;
  secret = randomBytes(32).toString('base64url');
  const cred = await ownerDb().intakeCredential.create({
    data: {
      tenantId: tenant.id,
      name: 'Smoke test (temporary)',
      username,
      secretHash: createHash('sha256').update(secret).digest('hex'),
    },
  });
  created = { id: cred.id, tenantId: tenant.id };
}

async function post(body: unknown, auth: string | null) {
  const started = performance.now();
  const res = await fetch(`${baseUrl}/api/webleads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json, ms: Math.round(performance.now() - started) };
}

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => results.push({ check: name, ok, detail });

try {
  await setupCredential();
  const auth = 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64');

  const a = await post(mainSite, auth);
  check(
    'main-site payload → 201',
    a.status === 201 && a.json?.['success'] === true,
    `${a.status} ${JSON.stringify(a.json)} in ${a.ms} ms`,
  );
  check('answers inside the 4 s sender timeout', a.ms < 4000, `${a.ms} ms`);
  const b = await post(blog, auth);
  check(
    'blog payload → 201',
    b.status === 201 && b.json?.['success'] === true,
    `${b.status} ${JSON.stringify(b.json)}`,
  );
  const c = await post(mainSite, auth);
  check(
    'repeat phone → DUPLICATE',
    c.status === 201 && c.json?.['status'] === 'DUPLICATE',
    `${c.status} ${JSON.stringify(c.json)}`,
  );
  const d = await post(
    mainSite,
    'Basic ' + Buffer.from(`${username}:wrong-secret-0000000000000`).toString('base64'),
  );
  check('wrong secret → 401', d.status === 401, `${d.status} ${JSON.stringify(d.json)}`);
  const e = await post({ name: 'No phone' }, auth);
  check('missing phone → 422', e.status === 422, `${e.status} ${JSON.stringify(e.json)}`);

  if (created) {
    const { ownerDb } = await import('@avn-cms/db/owner');
    const row = await ownerDb().webLead.findFirst({ where: { id: String(a.json?.['id']) } });
    check(
      'stored row maps the LeadXP fields',
      Boolean(
        row &&
        row.phoneE164 === `+9190009${suffix}` &&
        row.neetScore === 450 &&
        row.intakeChannel === 'LEADXP_COMPAT' &&
        row.tenantId === created.tenantId,
      ),
      row ? `phone ${row.phoneE164}, neet ${row.neetScore}, channel ${row.intakeChannel}` : 'row not found',
    );
  }
} finally {
  if (created) {
    const { ownerDb } = await import('@avn-cms/db/owner');
    await ownerDb().intakeCredential.update({ where: { id: created.id }, data: { revokedAt: new Date() } });
    const { disconnectAll } = await import('@avn-cms/db');
    await disconnectAll();
  }
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}  — ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed ? `\n${failed} check(s) failed.` : `\nAll ${results.length} checks passed against ${baseUrl}.`,
);
process.exit(failed ? 1 : 0);
