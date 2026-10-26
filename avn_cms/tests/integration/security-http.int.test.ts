import { beginMfaEnrollment, confirmMfa, login, totpAt } from '@avn-cms/auth';
import { resetConfigForTests } from '@avn-cms/config';
import { ownerDb } from '@avn-cms/db/owner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_PASSWORD, makeTenant, makeUser, resetData } from '../fixtures/factory';
import {
  HTTP_METHODS,
  ROUTES,
  call,
  freshIp,
  methodsOf,
  signIn,
  type Caller,
  type Method,
} from './helpers/http';

/**
 * The request gate, end to end through the real route handlers: who may call what, CSRF and
 * cross-site requests, rate limits and the address they count against, sign-in failures that give
 * nothing away, input handling, and what an error response may contain.
 */

/** Routes that are open to people who are not signed in, on purpose. Anything else needs a session. */
const PUBLIC = [
  'health',
  // Monitoring scrape: no session, a bearer token instead (404 while METRICS_TOKEN is unset).
  'metrics',
  'webleads',
  'public/web-leads',
  'public/webhooks/leads',
  'auth/login',
  'auth/forgot-password',
  'auth/reset-password',
];
const MUTATING: Method[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

async function endpoints(filter: (route: string, method: Method) => boolean) {
  const out: { route: string; method: Method }[] = [];
  for (const route of ROUTES) {
    for (const method of await methodsOf(route)) if (filter(route, method)) out.push({ route, method });
  }
  return out;
}

describe('the request gate', () => {
  let tenant: { id: string };
  let admin: Caller;
  let counselor: Caller;

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('sec-a');
    await makeUser(tenant.id, 'TENANT_ADMIN', 'admin@sec.test');
    await makeUser(tenant.id, 'COUNSELOR', 'counselor@sec.test');
    admin = await signIn('sec-a', 'admin@sec.test');
    counselor = await signIn('sec-a', 'counselor@sec.test');
  });

  afterEach(() => {
    process.env['TRUSTED_PROXY_HOPS'] = '1';
    delete process.env['MFA_REQUIRED_ROLES'];
    resetConfigForTests();
  });

  describe('every route', () => {
    it('is accounted for: the routes open to the public are exactly the listed ones', async () => {
      const found = ROUTES.filter((r) => PUBLIC.includes(r));
      expect(found.sort()).toEqual([...PUBLIC].sort());
      expect(ROUTES.length).toBeGreaterThan(55);
    });

    it('refuses a caller who is not signed in (401), unless it is open to the public', async () => {
      const failures: string[] = [];
      for (const { route, method } of await endpoints((r) => !PUBLIC.includes(r))) {
        const res = await call(route, method, { caller: null });
        if (res.status !== 401) failures.push(`${method} /api/${route} → ${res.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('refuses a signed-in caller who does not send the CSRF token, or sends someone else’s', async () => {
      const failures: string[] = [];
      for (const { route, method } of await endpoints(
        (r, m) => !PUBLIC.includes(r) && MUTATING.includes(m),
      )) {
        for (const csrf of ['none', 'not-the-token', counselor.csrf]) {
          const res = await call(route, method, { caller: admin, csrf });
          if (res.status !== 403)
            failures.push(`${method} /api/${route} (${csrf.slice(0, 6)}) → ${res.status}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it('refuses a state-changing request that another site started, even with the right token', async () => {
      const failures: string[] = [];
      for (const { route, method } of await endpoints(
        (r, m) => !PUBLIC.includes(r) && MUTATING.includes(m),
      )) {
        const foreignOrigin = await call(route, method, { caller: admin, origin: 'https://evil.example' });
        const crossSite = await call(route, method, {
          caller: admin,
          headers: { 'sec-fetch-site': 'cross-site' },
        });
        if (foreignOrigin.status !== 403)
          failures.push(`origin: ${method} /api/${route} → ${foreignOrigin.status}`);
        if (crossSite.status !== 403)
          failures.push(`fetch-site: ${method} /api/${route} → ${crossSite.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('only reads JSON or an upload form: a plain-text body (what a cross-site <form> can send) is refused', async () => {
      const failures: string[] = [];
      for (const { route, method } of await endpoints(
        (r, m) => !PUBLIC.includes(r) && MUTATING.includes(m),
      )) {
        const res = await call(route, method, {
          caller: admin,
          rawBody: '{"all":true}',
          headers: { 'content-type': 'text/plain' },
        });
        // Platform routes turn a workspace admin away before they look at the body at all.
        const expected = route.startsWith('platform/') ? 403 : 422;
        if (res.status !== expected) failures.push(`${method} /api/${route} → ${res.status}`);
      }
      expect(failures).toEqual([]);
    });

    it('lets the same request through when it comes from our own page', async () => {
      const res = await call('notifications/read', 'POST', { caller: admin, body: { all: true } });
      expect(res.status).toBe(200);
      // A command-line client sends no Origin; the token is still required.
      expect(
        (await call('notifications/read', 'POST', { caller: admin, body: { all: true }, origin: null }))
          .status,
      ).toBe(200);
      expect(
        (
          await call('notifications/read', 'POST', {
            caller: admin,
            body: { all: true },
            origin: null,
            csrf: 'none',
          })
        ).status,
      ).toBe(403);
    });

    it('never puts a stack trace, a query or a file path in an answer', async () => {
      const leaks: string[] = [];
      const nasty = ["' OR 1=1 --", '"><script>alert(1)</script>', '../../etc/passwd', '%00', 'null', '{}'];
      for (const { route, method } of await endpoints((r) => !PUBLIC.includes(r))) {
        for (const probe of [
          { caller: null },
          { caller: admin, params: { id: nasty[0]!, docType: nasty[2]!, report: nasty[1]! } },
        ]) {
          const res = await call(route, method, probe);
          const text = JSON.stringify(res.body);
          if (res.status >= 500) leaks.push(`${method} /api/${route} → ${res.status}`);
          if (/prisma|SELECT |INSERT |UPDATE "|node_modules|\.tsx?:\d+|at async|at Object/i.test(text)) {
            leaks.push(`${method} /api/${route}: ${text.slice(0, 80)}`);
          }
        }
      }
      expect(leaks).toEqual([]);
    });
  });

  describe('sessions', () => {
    it('stop working once revoked, expired, idle, or when the person or workspace is switched off', async () => {
      const probe = (c: Caller) => call('notifications/unread', 'GET', { caller: c });
      expect((await probe(counselor)).status).toBe(200);

      await ownerDb().session.updateMany({
        where: { userId: counselor.userId },
        data: { revokedAt: new Date() },
      });
      expect((await probe(counselor)).status).toBe(401);

      const again = await signIn('sec-a', 'counselor@sec.test');
      await ownerDb().session.updateMany({
        where: { userId: again.userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await probe(again)).status).toBe(401);

      const idle = await signIn('sec-a', 'counselor@sec.test');
      await ownerDb().session.updateMany({
        where: { userId: idle.userId, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { lastSeenAt: new Date(Date.now() - 49 * 3_600_000) },
      });
      expect((await probe(idle)).status).toBe(401);

      const disabled = await signIn('sec-a', 'counselor@sec.test');
      expect((await probe(disabled)).status).toBe(200);
      await ownerDb().user.update({ where: { id: disabled.userId }, data: { status: 'DISABLED' } });
      expect((await probe(disabled)).status).toBe(401);

      expect((await probe(admin)).status).toBe(200);
      await ownerDb().tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED' } });
      expect((await probe(admin)).status).toBe(401);
    });

    it('a cookie that is not a session, or is absurdly long, is just "not signed in"', async () => {
      for (const token of ['', 'x', 'a'.repeat(5000), '../../', "' OR 1=1 --"]) {
        const res = await call('notifications/unread', 'GET', { caller: { ...admin, token }, csrf: 'none' });
        expect(res.status, token.slice(0, 20)).toBe(401);
      }
    });

    it('waits for the second factor: a session that has not passed it reaches nothing but sign-out and the code', async () => {
      const mfaUser = await makeUser(tenant.id, 'COUNSELOR', 'mfa@sec.test');
      const first = await signIn('sec-a', 'mfa@sec.test');
      const begun = (await beginMfaEnrollment(mfaUser.id, TEST_PASSWORD))!;
      await confirmMfa(
        mfaUser.id,
        (await ownerDb().session.findFirstOrThrow({ where: { userId: mfaUser.id } })).id,
        totpAt(begun.secret, Date.now()),
      );
      expect(first.token).toBeTruthy();

      const res = await login({ workspace: 'sec-a', email: 'mfa@sec.test', password: TEST_PASSWORD });
      if (!res.ok || !res.mfaRequired) throw new Error('expected a second factor');
      const principal = await ownerDb().session.findFirstOrThrow({
        where: { userId: mfaUser.id, mfaVerified: false },
      });
      const pending: Caller = {
        token: res.token,
        csrf: principal.csrfSecret,
        userId: mfaUser.id,
        role: 'COUNSELOR',
      };

      const blocked = await call('notifications/unread', 'GET', { caller: pending });
      expect(blocked.status).toBe(401);
      expect(blocked.body.error.details).toMatchObject({ mfaRequired: true });
      expect((await call('students', 'GET', { caller: pending })).status).toBe(401);
      // Sign-out is always possible.
      expect((await call('auth/logout', 'POST', { caller: pending })).status).toBe(200);
    });
  });

  describe('roles that must use two-step verification', () => {
    it('can do nothing but set it up (and sign out) until they have', async () => {
      process.env['MFA_REQUIRED_ROLES'] = 'TENANT_ADMIN';
      resetConfigForTests();
      const required = await signIn('sec-a', 'admin@sec.test');

      for (const [route, method] of [
        ['students', 'GET'],
        ['notifications/unread', 'GET'],
        ['users', 'GET'],
        ['settings', 'GET'],
      ] as const) {
        const res = await call(route, method, { caller: required });
        expect(res.status, route).toBe(403);
        expect(res.body.error.details).toMatchObject({ mfaSetupRequired: true });
      }
      // A role that does not need it is unaffected.
      expect((await call('notifications/unread', 'GET', { caller: counselor })).status).toBe(200);

      // Setting it up is allowed, and needs the password.
      expect(
        (
          await call('auth/mfa/enroll', 'POST', {
            caller: required,
            body: { currentPassword: 'wrong-password' },
          })
        ).status,
      ).toBe(422);
      const enrol = await call('auth/mfa/enroll', 'POST', {
        caller: required,
        body: { currentPassword: TEST_PASSWORD },
      });
      expect(enrol.status).toBe(200);
      const confirm = await call('auth/mfa/confirm', 'POST', {
        caller: required,
        body: { code: totpAt(enrol.body.data.secret, Date.now()) },
      });
      expect(confirm.status).toBe(200);
      expect(confirm.body.data.recoveryCodes).toHaveLength(10);

      // Now it is on, it cannot be switched off by that role.
      const off = await call('auth/mfa/disable', 'POST', {
        caller: required,
        body: { code: confirm.body.data.recoveryCodes[0] },
      });
      expect(off.status).toBe(403);
      expect((await call('notifications/unread', 'GET', { caller: required })).status).toBe(200);
    });

    it('can still sign out while it is not set up', async () => {
      process.env['MFA_REQUIRED_ROLES'] = 'TENANT_ADMIN';
      resetConfigForTests();
      const required = await signIn('sec-a', 'admin@sec.test');
      expect((await call('auth/logout', 'POST', { caller: required })).status).toBe(200);
    });
  });

  describe('signing in', () => {
    const attempt = (body: Record<string, string>, ip = freshIp(), extra: Record<string, string> = {}) =>
      call('auth/login', 'POST', {
        body,
        ip,
        caller: null,
        ...(Object.keys(extra).length ? { headers: extra } : {}),
      });
    const wrong = { workspace: 'sec-a', email: 'counselor@sec.test', password: 'Not-The-Password-1' };

    it('answers the same for an unknown email, a wrong password and an account paused for too many tries', async () => {
      const unknown = await attempt({
        workspace: 'sec-a',
        email: 'nobody@sec.test',
        password: 'Whatever-123456',
      });
      expect(unknown.status).toBe(401);
      for (let i = 0; i < 6; i++) expect((await attempt(wrong)).status).toBe(401);
      expect(
        (await ownerDb().user.findUniqueOrThrow({ where: { id: counselor.userId } })).lockedUntil,
      ).not.toBeNull();

      // Even the right password is turned away while paused, with exactly the same answer.
      const paused = await attempt({
        workspace: 'sec-a',
        email: 'counselor@sec.test',
        password: TEST_PASSWORD,
      });
      expect(paused.status).toBe(unknown.status);
      expect(paused.body).toEqual(unknown.body);
      expect(paused.headers.get('retry-after')).toBeNull();
      expect(unknown.headers.get('retry-after')).toBeNull();

      const noWorkspace = await attempt({
        workspace: 'no-such-agency',
        email: 'counselor@sec.test',
        password: TEST_PASSWORD,
      });
      expect(noWorkspace.body).toEqual(unknown.body);
    });

    it('only says "suspended" about a workspace, never about a person', async () => {
      await ownerDb().tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED' } });
      const res = await attempt({
        workspace: 'sec-a',
        email: 'nobody@sec.test',
        password: 'Whatever-123456',
      });
      expect(res.body.error.message).toMatch(/suspended/i);
      await ownerDb().tenant.update({ where: { id: tenant.id }, data: { status: 'ACTIVE' } });
      const person = await attempt({
        workspace: 'sec-a',
        email: 'nobody@sec.test',
        password: 'Whatever-123456',
      });
      expect(person.body.error.message).not.toMatch(/suspended|locked|paused/i);
    });

    it('allows ten tries a minute from one address, then slows that address down', async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++)
        statuses.push(
          (await attempt({ workspace: 'sec-a', email: 'nobody@sec.test', password: 'Whatever-123456' }, ip))
            .status,
        );
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      // Someone else is unaffected.
      expect(
        (await attempt({ workspace: 'sec-a', email: 'nobody@sec.test', password: 'Whatever-123456' })).status,
      ).toBe(401);
      const limited = await attempt(
        { workspace: 'sec-a', email: 'nobody@sec.test', password: 'Whatever-123456' },
        ip,
      );
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    });

    it('cannot dodge that limit by inventing forwarding addresses', async () => {
      const real = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        // The caller prepends made-up addresses; our proxy appended the one it really saw.
        const res = await attempt(
          { workspace: 'sec-a', email: 'nobody@sec.test', password: 'Whatever-123456' },
          `203.0.113.${i + 1}, ${real}`,
        );
        statuses.push(res.status);
      }
      expect(statuses.slice(10)).toEqual([429, 429]);
    });

    it('with no proxy in front, ignores the forwarding header altogether', async () => {
      process.env['TRUSTED_PROXY_HOPS'] = '0';
      resetConfigForTests();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push(
          (await attempt({ workspace: 'sec-a', email: 'nobody@sec.test', password: 'Whatever-123456' }))
            .status,
        );
      }
      expect(statuses.slice(10)).toEqual([429, 429]);
    });

    it('refuses a sign-in, password reset or reset request that another site started', async () => {
      const body = { workspace: 'sec-a', email: 'counselor@sec.test', password: TEST_PASSWORD };
      for (const route of ['auth/login', 'auth/forgot-password', 'auth/reset-password']) {
        const foreign = await call(route, 'POST', { body, caller: null, origin: 'https://evil.example' });
        const fetchSite = await call(route, 'POST', {
          body,
          caller: null,
          headers: { 'sec-fetch-site': 'cross-site' },
        });
        expect(foreign.status, route).toBe(403);
        expect(fetchSite.status, route).toBe(403);
      }
      // …but a command-line client (no Origin) and our own page are fine.
      expect((await call('auth/login', 'POST', { body, caller: null, origin: null })).status).toBe(200);
      expect((await call('auth/login', 'POST', { body, caller: null })).status).toBe(200);
    });

    it('hands out a new session each time, and the cookie token is never the stored value', async () => {
      const a = await signIn('sec-a', 'counselor@sec.test');
      const b = await signIn('sec-a', 'counselor@sec.test');
      expect(a.token).not.toBe(b.token);
      expect(a.csrf).not.toBe(b.csrf);
      const stored = await ownerDb().session.findMany({ where: { userId: a.userId } });
      expect(stored.some((s) => s.tokenHash === a.token)).toBe(false);
    });
  });

  describe('unsigned callers in bulk', () => {
    it('are counted per address, so guessing sessions or flooding the API is capped', async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 123; i++)
        statuses.push((await call('notifications/unread', 'GET', { caller: null, ip })).status);
      expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(120)).toEqual([429, 429, 429]);
      // A signed-in person on the same address is not the one being slowed.
      expect((await call('notifications/unread', 'GET', { caller: admin, ip })).status).toBe(200);
    });
  });

  describe('what the routes accept', () => {
    it('answers bad input with a 4xx, never a crash', async () => {
      const bad = [
        call('notifications/read', 'POST', { caller: admin, rawBody: '{not json' }),
        call('notifications/read', 'POST', { caller: admin, body: { ids: 'nope' } }),
        call('notifications/read', 'POST', { caller: admin, body: [] }),
        call('users/[id]', 'PATCH', { caller: admin, params: { id: 'not-a-uuid' }, body: { name: 'x' } }),
        call('students/[id]', 'DELETE', { caller: admin, params: { id: '1; DROP TABLE students' } }),
        call('students', 'GET', { caller: admin, query: { cursor: 'not-a-cursor' } }),
        call('students', 'GET', { caller: admin, query: { limit: '99999999' } }),
        call('students', 'GET', { caller: admin, query: { stage: 'DROP' } }),
        call('reports/[report]', 'GET', { caller: admin, params: { report: '../../etc' } }),
      ];
      for (const res of await Promise.all(bad)) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    });

    it('refuses a body over 64 KB', async () => {
      const res = await call('notifications/read', 'POST', {
        caller: admin,
        body: { ids: [], pad: 'x'.repeat(70_000) },
      });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/too large/i);
    });

    it('does not let a caller set fields it does not own (mass assignment)', async () => {
      const other = await makeTenant('sec-other');
      const { id: studentId } = await ownerDb().student.create({
        data: { tenantId: tenant.id, name: 'Before', phoneRaw: '9000000001', phoneE164: '+919000000001' },
        select: { id: true },
      });
      const res = await call('students/[id]', 'PATCH', {
        caller: admin,
        params: { id: studentId },
        body: {
          name: 'After',
          tenantId: other.id,
          createdById: admin.userId,
          deletedAt: '2020-01-01T00:00:00Z',
          id: '11111111-1111-4111-8111-111111111111',
        },
      });
      expect(res.status).toBe(200);
      const row = await ownerDb().student.findUniqueOrThrow({ where: { id: studentId } });
      expect(row).toMatchObject({ name: 'After', tenantId: tenant.id, createdById: null, deletedAt: null });

      const rule = await call('automations', 'POST', {
        caller: admin,
        body: {
          name: 'Mine',
          trigger: 'STAGE_CHANGED',
          conditions: { toStage: 'ENROLLED' },
          actions: [{ type: 'stop_reminders' }],
          tenantId: other.id,
          starterKey: 'route_web_leads',
          createdById: '11111111-1111-4111-8111-111111111111',
        },
      });
      expect(rule.status).toBe(201);
      const created = await ownerDb().automationRule.findFirstOrThrow({ where: { name: 'Mine' } });
      expect(created).toMatchObject({ tenantId: tenant.id, starterKey: null, createdById: admin.userId });

      // A role can only be one of the workspace roles; "super admin" is not a choice.
      const promote = await call('users/[id]', 'PATCH', {
        caller: admin,
        params: { id: counselor.userId },
        body: { role: 'SUPER_ADMIN' },
      });
      expect(promote.status).toBe(422);
      expect((await ownerDb().user.findUniqueOrThrow({ where: { id: counselor.userId } })).roleCode).toBe(
        'COUNSELOR',
      );
    });
  });

  it('knows every method it checks', () => {
    expect(HTTP_METHODS).toContain('PATCH');
  });
});
