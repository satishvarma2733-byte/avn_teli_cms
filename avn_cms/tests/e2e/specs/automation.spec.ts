import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { createClient } from '../../../packages/db/src/testing';
import { as, expectAccessible, expectNoSidewaysScroll, testPhone } from './helpers';

/**
 * Phase 8: the five starter rules each fire for real (web lead routed, uncontacted lead flagged,
 * overdue call escalated, Interested schedules a call, Enrolled stops reminders), a rule that is
 * off never runs, runs are logged, and rules belong to the admin of one workspace.
 *
 * Rules act on the demo workspace's whole data, so the file removes everything it made at the end.
 */
const ownerUrl = () => {
  const url = process.env['TEST_DATABASE_OWNER_URL'] ?? '';
  expect(url, 'TEST_DATABASE_OWNER_URL must name the *_test database').toMatch(/_test(\?|$)/);
  return url;
};

const RULES = {
  route: 'Route new web leads to a counselor',
  uncontacted: 'Tell the admins about leads nobody has contacted',
  overdue: 'Escalate calls that are 24 hours overdue',
  interested: 'Schedule a call when a lead becomes Interested',
  enrolled: 'Stop reminders once a student is enrolled',
};

/** The worker's sweep for time-based rules, run once against the test database. */
function runWorkerOnce() {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)), 'src/run-once.ts'],
    {
      cwd: fileURLToPath(new URL('../../../apps/worker', import.meta.url)),
      env: {
        ...process.env,
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        DATABASE_OWNER_URL: ownerUrl(),
        REDIS_URL: '', // the sweep and the runs it finds need only the database
      },
      stdio: 'pipe',
    },
  );
}

async function withOwner<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const owner = createClient(ownerUrl(), { poolMax: 1 });
  try {
    return await fn(owner);
  } finally {
    await owner.$disconnect();
  }
}

/** A student with a counselor (Chaitanya), made the way a person would. Returns the lead's address. */
async function createLead(page: Page, label: string) {
  const phone = testPhone();
  const name = `${label} ${phone.slice(-4)}`;
  await page.goto('/app/leads/new');
  await page.getByLabel('Student name').fill(name);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByLabel('Source').selectOption({ label: 'Website' });
  await page.getByLabel('Counselor').selectOption({ label: 'Chaitanya Counselor' });
  await page.getByRole('button', { name: 'Save student' }).click();
  await expect(page).toHaveURL(/\/app\/leads\/[0-9a-f-]{36}$/);
  return { name, url: page.url(), id: page.url().split('/').pop()! };
}

async function changeStage(page: Page, stage: string) {
  await page.getByRole('button', { name: 'Change stage' }).click();
  await page.getByRole('dialog').getByLabel('Stage').selectOption(stage);
  await page.getByRole('button', { name: 'Save stage' }).click();
  await expect(page.getByText('Stage updated.')).toBeVisible();
}

const ruleCard = (page: Page, name: string) => page.getByRole('listitem').filter({ hasText: name });

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  // Leave the workspace as the other specs expect it: no rules, nothing the rules sent or flagged.
  await withOwner(async (db) => {
    await db.automationRun.deleteMany({});
    await db.automationRule.deleteMany({});
    await db.notification.deleteMany({
      where: { type: { in: ['automation.notify', 'followup.escalated'] } },
    });
    await db.followUp.updateMany({
      where: { escalatedAt: { not: null } },
      data: { escalatedAt: null, escalatedTo: null },
    });
  });
});

test.describe('admin: rules', () => {
  test.use(as('admin'));
  let authHeader = '';

  test('start empty, add the starter rules, build a rule, switch it off and on', async ({ page }) => {
    await page.goto('/app/automations');
    await expect(page.getByText('No rules yet')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Add starter rules' }).click();
    await expect(page.getByText('Added 5 starter rules.')).toBeVisible();
    for (const name of Object.values(RULES)) await expect(ruleCard(page, name)).toBeVisible();
    // Everything is on, and there is nothing more to add.
    await expect(page.getByRole('button', { name: 'Add starter rules' })).toHaveCount(0);
    await expect(ruleCard(page, RULES.route)).toContainText('A web lead arrives — new submissions only');
    await expect(ruleCard(page, RULES.interested)).toContainText('changes to Interested');
    await expectAccessible(page);

    // The builder explains what's missing instead of failing silently.
    await page.getByRole('button', { name: 'New rule' }).click();
    const dialog = page.getByRole('dialog');
    await expectAccessible(page);
    await dialog.getByLabel('This happens').selectOption('STAGE_CHANGED');
    await dialog.getByLabel('Changes to').selectOption('NOT_INTERESTED');
    await dialog.getByLabel('Action 1').selectOption('notify');
    await dialog.getByLabel('Tell').selectOption('admins');
    await dialog.getByRole('button', { name: 'Create rule' }).click();
    await expect(dialog.getByText('Give the rule a name.')).toBeVisible();
    await expect(dialog.getByText('Write the notification’s title.')).toBeVisible();

    await dialog.locator('#rule-name').fill('Tell me when interest is lost');
    await dialog.getByLabel('Title').fill('Lost: {name}');
    await dialog.getByRole('button', { name: 'Create rule' }).click();
    await expect(page.getByText('“Tell me when interest is lost” was created.')).toBeVisible();
    const custom = ruleCard(page, 'Tell me when interest is lost');
    await expect(custom).toContainText('changes to Not interested');
    await expect(custom).toContainText('Notify the admins: “Lost: {name}”');

    await custom.getByRole('button', { name: 'Turn off: Tell me when interest is lost' }).click();
    await expect(page.getByText('is off. It won’t run until you turn it on.')).toBeVisible();
    await expect(custom.getByText('Off', { exact: true })).toBeVisible();
    await custom.getByRole('button', { name: 'Turn on: Tell me when interest is lost' }).click();
    await expect(custom.getByText('On', { exact: true })).toBeVisible();

    // Editing keeps what was there; deleting asks first.
    await custom.getByRole('button', { name: 'Edit: Tell me when interest is lost' }).click();
    await expect(page.getByRole('dialog').getByLabel('Title')).toHaveValue('Lost: {name}');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await custom.getByRole('button', { name: 'Delete: Tell me when interest is lost' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete rule' }).click();
    await expect(page.getByText('“Tell me when interest is lost” was deleted.')).toBeVisible();
    await expect(ruleCard(page, 'Tell me when interest is lost')).toHaveCount(0);
  });

  test('a new web lead is routed to a counselor, who is told and can take it', async ({
    page,
    request,
    browser,
  }) => {
    // A website connection, as in the intake flow.
    await page.goto('/app/settings/integrations');
    await page.getByRole('button', { name: 'New credential' }).click();
    await page.getByLabel('Name').fill('Automation e2e site');
    await page.getByRole('button', { name: 'Create' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Credential created')).toBeVisible();
    authHeader = (await dialog.locator('code').nth(2).textContent())!.trim();
    await page.getByRole('button', { name: 'I have saved it' }).click();

    const phone = testPhone();
    const name = `Routed Enquiry ${phone.slice(-4)}`;
    const res = await request.post('/api/webleads', {
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      data: { name, mobile: phone, email: 'routed@example.test', neet_score: 500, source: 'Landing Page' },
    });
    expect(res.status()).toBe(201);

    // The rule runs right after the submission is saved; the admin sees who it went to.
    await page.goto('/app/web-leads');
    const row = page.getByRole('listitem').filter({ hasText: name });
    let counselor = '';
    await expect(async () => {
      await page.reload();
      const text = (await row.textContent()) ?? '';
      const found = /routed to (Chaitanya|Charitha) Counselor/.exec(text);
      expect(found, 'the web lead should be routed to a counselor').not.toBeNull();
      counselor = found![1]!;
    }).toPass({ timeout: 20_000 });
    const mine = counselor === 'Chaitanya' ? 'counselor1' : 'counselor2';
    const other = counselor === 'Chaitanya' ? 'counselor2' : 'counselor1';

    // The run log says what happened.
    await page.goto('/app/automations');
    await page.getByRole('tab', { name: 'Run log' }).click();
    await page.getByLabel('Rule').selectOption({ label: RULES.route });
    const run = page.getByRole('listitem').filter({ hasText: name });
    await expect(run).toContainText('Done');
    await expect(run).toContainText(`Routed to ${counselor} Counselor`);
    await expectAccessible(page);

    // The other counselor sees nothing of it.
    const outsider = await browser.newContext(as(other));
    const outsiderPage = await outsider.newPage();
    await outsiderPage.goto('/app/web-leads');
    await expect(outsiderPage.getByText('No web leads here')).toBeVisible();
    await expect(outsiderPage.getByText(name)).toHaveCount(0);
    await outsider.close();

    // The chosen counselor is told, finds it routed to them, and converts it.
    const owner = await browser.newContext(as(mine));
    const ownerPage = await owner.newPage();
    await ownerPage.goto('/app/notifications');
    await expect(ownerPage.getByText(`New web lead: ${name}`)).toBeVisible();
    await expect(ownerPage.getByRole('link', { name: /^Notifications/ })).toContainText('1');
    await expectAccessible(ownerPage);
    await ownerPage.getByRole('button', { name: `Mark read: New web lead: ${name}` }).click();
    await expect(ownerPage.getByText('Nothing unread')).toHaveCount(0);
    await expect(ownerPage.getByRole('button', { name: /^Mark read:/ })).toHaveCount(0);
    await expect(ownerPage.getByRole('link', { name: /^Notifications/ })).not.toContainText('1');

    await ownerPage.goto('/app/web-leads');
    const mineRow = ownerPage.getByRole('listitem').filter({ hasText: name });
    await expect(mineRow).toContainText('routed to you');
    await expect(mineRow.getByRole('button', { name: 'Spam' })).toHaveCount(0); // admins only
    await expectAccessible(ownerPage);
    await mineRow.getByRole('button', { name: 'Convert' }).click();
    await expect(ownerPage.getByText('The new lead will be assigned to you.')).toBeVisible();
    await ownerPage.getByRole('dialog').getByRole('button', { name: 'Convert' }).click();
    await expect(ownerPage.getByText('Converted to a new lead.')).toBeVisible();
    await owner.close();
  });

  test('Interested schedules a call; Enrolled stops the reminders', async ({ page }) => {
    const lead = await createLead(page, 'Stage Rules');
    await expect(page.getByText(/Next call/)).toHaveCount(0);

    await changeStage(page, 'INTERESTED');
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(/Next call/)).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await expect(page.getByText(`Call scheduled by automation “${RULES.interested}”`)).toBeVisible();

    await changeStage(page, 'ENROLLED');
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(/Next call/)).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await expect(page.getByText(`1 reminder stopped by automation “${RULES.enrolled}”`)).toBeVisible();

    // Both runs are in the log, newest first.
    await page.goto('/app/automations');
    await page.getByRole('tab', { name: 'Run log' }).click();
    const runs = page.getByRole('listitem').filter({ hasText: lead.name });
    await expect(runs.filter({ hasText: RULES.enrolled })).toContainText('Stopped 1 reminder');
    await expect(runs.filter({ hasText: RULES.interested })).toContainText('Scheduled a call for Chaitanya');
  });

  test('the worker finds an uncontacted lead and an overdue call', async ({ page, browser }) => {
    const lead = await createLead(page, 'Waiting Lead');
    // Make time pass: the lead arrived 3 hours ago, and a call for it was due 30 hours ago.
    await withOwner(async (db) => {
      const user = await db.user.findFirstOrThrow({ where: { email: 'counselor1@demo.test' } });
      const found = await db.lead.findFirstOrThrow({ where: { id: lead.id } });
      await db.lead.update({
        where: { id: lead.id },
        data: { createdAt: new Date(Date.now() - 3 * 3_600_000) },
      });
      await db.followUp.create({
        data: {
          tenantId: found.tenantId,
          leadId: lead.id,
          assigneeId: user.id,
          scheduledAt: new Date(Date.now() - 30 * 3_600_000),
          disposition: 'SCHEDULED',
          priority: 'NORMAL',
          createdById: user.id,
        },
      });
    });

    runWorkerOnce();

    // Uncontacted: the admins were told.
    const told = await withOwner((db) =>
      db.notification.count({
        where: { title: `Not contacted yet: ${lead.name}`, type: 'automation.notify' },
      }),
    );
    expect(told, 'every admin hears about the uncontacted lead').toBeGreaterThanOrEqual(1);
    // Overdue: the call is escalated, and its owner and the admins are told.
    const escalated = await withOwner((db) =>
      db.followUp.findMany({ where: { leadId: lead.id }, select: { escalatedAt: true } }),
    );
    expect(escalated.map((f) => f.escalatedAt !== null)).toEqual([true]);

    const counselor = await browser.newContext(as('counselor1'));
    const counselorPage = await counselor.newPage();
    await counselorPage.goto('/app/notifications');
    await expect(counselorPage.getByText(`Overdue call: ${lead.name}`)).toBeVisible();
    await expect(counselorPage.getByText('This call is 30 hours overdue.')).toBeVisible();
    await counselor.close();

    // The log shows both runs, and a second sweep does not repeat them.
    await page.goto('/app/automations');
    await page.getByRole('tab', { name: 'Run log' }).click();
    await page.getByLabel('Rule').selectOption({ label: RULES.overdue });
    const run = page.getByRole('listitem').filter({ hasText: lead.name });
    await expect(run).toContainText('Escalated; told');
    await expectAccessible(page);

    runWorkerOnce();
    const runs = await withOwner((db) =>
      db.automationRun.count({ where: { entityId: lead.id, event: 'LEAD_UNCONTACTED' } }),
    );
    expect(runs).toBe(1);
  });

  test('a rule that is off never runs', async ({ page, request }) => {
    const before = await withOwner((db) =>
      db.automationRun.count({ where: { rule: { starterKey: 'route_web_leads' } } }),
    );

    await page.goto('/app/automations');
    await ruleCard(page, RULES.route)
      .getByRole('button', { name: `Turn off: ${RULES.route}` })
      .click();
    await expect(page.getByText(`“${RULES.route}” is off.`)).toBeVisible();

    const phone = testPhone();
    const name = `Unrouted Enquiry ${phone.slice(-4)}`;
    const res = await request.post('/api/webleads', {
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      data: { name, mobile: phone, email: 'unrouted@example.test', source: 'Landing Page' },
    });
    expect(res.status()).toBe(201);

    await page.goto('/app/web-leads');
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('routed to');
    const after = await withOwner((db) =>
      db.automationRun.count({ where: { rule: { starterKey: 'route_web_leads' } } }),
    );
    expect(after).toBe(before);

    // Turned back on, it is used again by the next one.
    await page.goto('/app/automations');
    await ruleCard(page, RULES.route)
      .getByRole('button', { name: `Turn on: ${RULES.route}` })
      .click();
    await expect(page.getByText(`“${RULES.route}” is on.`)).toBeVisible();
  });
});

test.describe('who can use automations', () => {
  test('counselors and telecallers have no rules page and no rules API', async ({ browser }) => {
    for (const role of ['counselor1', 'telecaller1'] as const) {
      const context = await browser.newContext(as(role));
      const page = await context.newPage();
      await page.goto('/app/automations');
      await expect(page).toHaveURL(/\/app\/dashboard$/);
      await expect(page.getByRole('link', { name: 'Automations' })).toHaveCount(0);
      expect((await page.request.get('/api/automations')).status()).toBe(403);
      expect((await page.request.get('/api/automations/runs')).status()).toBe(403);
      await context.close();
    }
  });

  test('rules stay inside their workspace', async () => {
    const counts = await withOwner(async (db) => {
      const other = await db.tenant.findUniqueOrThrow({ where: { slug: 'other' } });
      const demo = await db.tenant.findUniqueOrThrow({ where: { slug: 'demo' } });
      return {
        otherRules: await db.automationRule.count({ where: { tenantId: other.id } }),
        otherRuns: await db.automationRun.count({ where: { tenantId: other.id } }),
        otherNotes: await db.notification.count({ where: { tenantId: other.id } }),
        demoRules: await db.automationRule.count({ where: { tenantId: demo.id } }),
        demoRuns: await db.automationRun.count({ where: { tenantId: demo.id } }),
      };
    });
    expect(counts.demoRules).toBe(5);
    expect(counts.demoRuns).toBeGreaterThan(0);
    expect(counts).toMatchObject({ otherRules: 0, otherRuns: 0, otherNotes: 0 });
  });

  test.describe('on a phone', () => {
    test.use(as('admin'));
    test('the pages fit the screen', async ({ page }) => {
      await page.goto('/app/automations');
      await expect(ruleCard(page, RULES.route)).toBeVisible();
      await expectNoSidewaysScroll(page);
      await page.getByRole('tab', { name: 'Run log' }).click();
      await expectNoSidewaysScroll(page);
      await page.goto('/app/notifications');
      await expectNoSidewaysScroll(page);
      await page.goto('/app/web-leads');
      await expectNoSidewaysScroll(page);
    });
  });
});
