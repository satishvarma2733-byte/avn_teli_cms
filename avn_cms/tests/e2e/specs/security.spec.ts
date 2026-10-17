import { expect, test, type Page } from '@playwright/test';

import { hashPassword } from '../../../packages/auth/src/password';
import { totpAt } from '../../../packages/auth/src/totp';
import { createClient } from '../../../packages/db/src/testing';
import { E2E_PASSWORD } from '../global-setup';
import { as, expectAccessible, testPhone } from './helpers';

/**
 * Phase 9 in a real browser: the headers and CSP the pages really carry (and that nothing the app
 * needs is blocked by them), hostile text rendered as text, sign-in that does not follow a link to
 * another site, and two-step verification with recovery codes from the person's side.
 */
const ownerUrl = () => {
  const url = process.env['TEST_DATABASE_OWNER_URL'] ?? '';
  expect(url, 'TEST_DATABASE_OWNER_URL must name the *_test database').toMatch(/_test(\?|$)/);
  return url;
};

async function withOwner<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const owner = createClient(ownerUrl(), { poolMax: 1 });
  try {
    return await fn(owner);
  } finally {
    await owner.$disconnect();
  }
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Workspace').fill('demo');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

test.describe('headers', () => {
  test('pages carry the full policy, and the nonce in the CSP is the one on the page’s scripts', async ({
    request,
  }) => {
    const res = await request.get('/login');
    const h = res.headers();
    const csp = h['content-security-policy']!;
    const headerNonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    expect(await res.text()).toContain(`nonce="${headerNonce}"`);
    for (const rule of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "style-src-attr 'unsafe-inline'",
    ]) {
      expect(csp, rule).toContain(rule);
    }
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(csp).not.toMatch(/style-src 'self'[^;]*'unsafe-inline'/);
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(h['permissions-policy']).toContain('camera=()');
    expect(h['x-powered-by']).toBeUndefined();
  });

  test('the API answers with a policy that lets a response load nothing, and is never cached', async ({
    request,
  }) => {
    for (const path of ['/api/health', '/api/students', '/api/auth/sessions']) {
      const res = await request.get(path);
      const h = res.headers();
      expect(h['content-security-policy'], path).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(h['cache-control'], path).toContain('no-store');
      expect(h['x-content-type-options'], path).toBe('nosniff');
      expect(h['x-powered-by'], path).toBeUndefined();
    }
    // Errors say what happened and nothing about how.
    const err = await (await request.get('/api/students')).json();
    expect(Object.keys(err.error).sort()).toEqual(['code', 'message']);
  });

  test.describe('signed in', () => {
    test.use(as('admin'));

    test('pages are never cached by the browser or a shared cache', async ({ page }) => {
      const res = await page.goto('/app/dashboard');
      const cacheControl = res!.headers()['cache-control'] ?? '';
      expect(cacheControl).toMatch(/no-store|private/);
    });

    test('the session cookie is httpOnly, SameSite and scoped to the whole site', async ({
      page,
      context,
    }) => {
      await page.goto('/app/dashboard');
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === 'avn_session')!;
      expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
      // The browser cannot read it, so a script on the page could not steal it.
      expect(await page.evaluate(() => document.cookie)).not.toContain('avn_session');
    });

    test('no page the policy was tightened for is blocked by it', async ({ page }) => {
      await page.addInitScript(() => {
        (window as unknown as { __csp: string[] }).__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          (window as unknown as { __csp: string[] }).__csp.push(
            `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample}`,
          );
        });
      });
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (/Content Security Policy|Refused to/i.test(msg.text())) consoleErrors.push(msg.text());
      });
      const paths = [
        '/app/dashboard',
        '/app/leads',
        '/app/leads/new',
        '/app/followups',
        '/app/web-leads',
        '/app/reports',
        '/app/imports',
        '/app/exports',
        '/app/documents',
        '/app/automations',
        '/app/notifications',
        '/app/users',
        '/app/audit',
        '/app/settings',
        '/app/settings/integrations',
        '/app/account',
      ];
      for (const path of paths) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
        expect(violations, path).toEqual([]);
      }
      // Dialogs and menus are where inline styles tend to hide.
      await page.goto('/app/automations');
      await page.getByRole('button', { name: 'New rule' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(consoleErrors).toEqual([]);
    });
  });
});

test.describe('hostile text is shown as text', () => {
  test.use(as('admin'));
  test.describe.configure({ mode: 'serial' });

  const hostile = (n: number) =>
    `"><img src=x onerror="window.__xss=${n}"><script>window.__xss=${n}</script>`;
  const marker = `Hostile ${Math.floor(Math.random() * 9000) + 1000}`;
  let leadUrl = '';

  test('a student, a web lead, a notification and a rule name carrying markup change nothing on the page', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __xss?: number }).__xss = undefined;
    });
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });

    // A student made through the form.
    const phone = testPhone();
    await page.goto('/app/leads/new');
    await page.getByLabel('Student name').fill(`${marker} ${hostile(1)}`);
    await page.getByLabel('Mobile number').fill(phone);
    await page.getByLabel('Source').selectOption({ label: 'Website' });
    await page.getByLabel('Counselor').selectOption({ label: 'Chaitanya Counselor' });
    await page.getByRole('button', { name: 'Save student' }).click();
    await expect(page).toHaveURL(/\/app\/leads\/[0-9a-f-]{36}$/);
    leadUrl = page.url();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('<img src=x');

    // The rest straight into the database, as intake, the worker and the rules would write them.
    await withOwner(async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'demo' } });
      const admin = await db.user.findFirstOrThrow({ where: { email: 'admin@demo.test' } });
      await db.webLead.create({
        data: {
          tenantId: tenant.id,
          name: `${marker} ${hostile(2)}`,
          phoneRaw: testPhone(),
          message: hostile(3),
          city: hostile(4),
          sourceLabel: hostile(5),
        },
      });
      await db.notification.create({
        data: {
          tenantId: tenant.id,
          userId: admin.id,
          type: 'x',
          title: `${marker} ${hostile(6)}`,
          body: hostile(7),
        },
      });
      const rule = await db.automationRule.create({
        data: {
          tenantId: tenant.id,
          name: `${marker} ${hostile(8)}`,
          trigger: 'STAGE_CHANGED',
          conditions: { toStage: 'ENROLLED' },
          actions: [{ type: 'notify', to: 'admins', title: hostile(9) }],
        },
      });
      await db.automationRun.create({
        data: {
          tenantId: tenant.id,
          ruleId: rule.id,
          event: 'STAGE_CHANGED',
          status: 'DONE',
          dedupeKey: 'hostile',
          payload: { name: hostile(10) },
          result: {
            summary: hostile(11),
            actions: [{ type: 'notify', outcome: 'done', detail: hostile(12) }],
          },
        },
      });
    });

    const pages = [
      leadUrl,
      '/app/leads',
      '/app/web-leads?status=',
      '/app/notifications',
      '/app/automations',
      '/app/audit',
      '/app/followups',
    ];
    for (const path of pages) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(
        await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
        path,
      ).toBeUndefined();
      expect(await page.locator('img[src="x"]').count(), path).toBe(0);
    }
    await page.goto('/app/automations');
    await page.getByRole('tab', { name: 'Run log' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: marker }).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(dialogs).toEqual([]);

    // The text itself is there, to be read.
    await page.goto('/app/notifications');
    await expect(page.getByText('<img src=x').first()).toBeVisible();
  });

  test.afterAll(async () => {
    await withOwner(async (db) => {
      await db.automationRun.deleteMany({ where: { dedupeKey: 'hostile' } });
      await db.automationRule.deleteMany({ where: { name: { contains: marker } } });
      await db.notification.deleteMany({ where: { title: { contains: marker } } });
    });
  });
});

test.describe('signing in', () => {
  test('never follows a link to another site after sign-in', async ({ page }) => {
    // The browser reads "/\evil.example" as "//evil.example". It must be dropped, not followed.
    await page.goto('/login?next=%2F%5Cevil.example');
    await page.getByLabel('Workspace').fill('demo');
    await page.getByLabel('Email').fill('counselor1@demo.test');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);
    expect(new URL(page.url()).hostname).toBe('localhost');
  });

  test('does take people back to the page they asked for', async ({ page }) => {
    await page.goto('/app/leads?status=NEW');
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fleads/);
    await page.getByLabel('Workspace').fill('demo');
    await page.getByLabel('Email').fill('counselor1@demo.test');
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app\/leads/);
  });
});

test.describe('two-step verification', () => {
  const email = 'mfa.e2e@demo.test';
  const password = 'Mfa-E2e-Sign-In-2026-x';

  test.beforeAll(async () => {
    await withOwner(async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'demo' } });
      await db.user.deleteMany({ where: { email } });
      await db.user.create({
        data: {
          tenantId: tenant.id,
          roleCode: 'COUNSELOR',
          name: 'MFA E2E',
          email,
          passwordHash: await hashPassword(password),
        },
      });
    });
  });
  test.afterAll(async () => {
    await withOwner(async (db) => {
      await db.user.deleteMany({ where: { email } });
    });
  });

  test('set up with the password, save the codes, then sign in with a code, a recovery code, and get paused after wrong codes', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    // Turning it on needs the password again.
    await page.goto('/app/account');
    await page.getByRole('button', { name: 'Set up two-step verification' }).click();
    await page.getByLabel('Your password').fill('not-my-password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Incorrect password.')).toBeVisible();
    await page.getByLabel('Your password').fill(password);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
    const secret = (await page.locator('code').first().textContent())!.trim();
    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByText('That code is not valid')).toBeVisible();
    await page.getByLabel('Verification code').fill(totpAt(secret, Date.now()));
    await page.getByRole('button', { name: 'Turn on' }).click();

    // The recovery codes are shown once and must be acknowledged.
    await expect(page.getByText('Save your recovery codes now')).toBeVisible();
    const codes = await page.locator('ol.font-mono li').allTextContents();
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    await expectAccessible(page);
    await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
    await page.getByLabel('I have saved my recovery codes').check();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Two-step verification is on.')).toBeVisible();
    await expect(page.getByText('10 recovery codes left.')).toBeVisible();

    // Next sign-in asks for a code. A fresh code from the app works.
    await signOut(page);
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/login\/mfa$/);
    await expectAccessible(page);
    await page.getByLabel('Verification code').fill(totpAt(secret, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);

    // A wrong code is refused; a recovery code works once and says so.
    await signOut(page);
    await signIn(page, email, password);
    await page.getByLabel('Verification code').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('That code is not valid.')).toBeVisible();
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(codes[0]!.toLowerCase());
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('You signed in with a recovery code')).toBeVisible();
    await expect(page.getByText('You have 9 left')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);
    await page.goto('/app/account');
    await expect(page.getByText('9 recovery codes left.')).toBeVisible();

    // The same recovery code is spent.
    await signOut(page);
    await signIn(page, email, password);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(codes[0]!);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('That code is not valid.')).toBeVisible();

    // Wrong codes in a row pause the checks.
    await page.getByRole('button', { name: 'Use the code from my app instead' }).click();
    for (let i = 0; i < 4; i++) {
      await page.getByLabel('Verification code').fill(`11111${i}`);
      await page.getByRole('button', { name: 'Verify' }).click();
      await expect(page.getByRole('alert')).toBeVisible();
    }
    await expect(page.getByText('Too many wrong codes')).toBeVisible();
  });
});
