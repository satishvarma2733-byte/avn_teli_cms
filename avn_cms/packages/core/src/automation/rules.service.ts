import { withTenant, type Prisma } from '@avn-cms/db';
import { z } from 'zod';

import { authorize } from '../policy/index';
import { audit } from '../shared/audit';
import type { Ctx } from '../shared/context';
import { conflict, invalid, notFound } from '../shared/errors';
import { afterCursor, decodeCursor, encodeCursor } from '../shared/pagination';
import {
  actionSchema,
  conditionSchemas,
  describeAction,
  describeConditions,
  MAX_RULES,
  ruleInputSchema,
  type AutomationAction,
  type RuleInput,
  type RulePatch,
  type runListQuerySchema,
} from './definitions';
import { STARTER_RULES, starterRuleRows } from './starter';

/**
 * Managing automation rules (admins only: `automation:manage`) and reading their run log.
 * Rules belong to one workspace; nothing here can see or change another's.
 */

/** Validates a whole rule and returns it with its conditions normalised; refusals list the fields. */
function validateRule(input: unknown): RuleInput {
  const parsed = ruleInputSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
    throw invalid('Some parts of the rule need attention.', { fields });
  }
  return {
    ...parsed.data,
    conditions: conditionSchemas[parsed.data.trigger].parse(parsed.data.conditions) as Record<
      string,
      unknown
    >,
  };
}

const parseActions = (raw: unknown): AutomationAction[] => {
  const parsed = z.array(actionSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
};

type RuleRow = Prisma.AutomationRuleGetPayload<Record<string, never>>;

function ruleView(
  r: RuleRow,
  stats?: {
    runs: number;
    done: number;
    skipped: number;
    failed: number;
    pending: number;
    lastRunAt: Date | null;
  },
) {
  const actions = parseActions(r.actions);
  return {
    id: r.id,
    name: r.name,
    isActive: r.isActive,
    trigger: r.trigger,
    conditions: r.conditions as Record<string, unknown>,
    actions,
    /** False when the stored actions no longer parse: the rule can't run until it is edited. */
    valid: actions.length > 0,
    starterKey: r.starterKey,
    when: describeConditions(r.trigger, r.conditions),
    does: actions.map(describeAction),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    stats: stats ?? { runs: 0, done: 0, skipped: 0, failed: 0, pending: 0, lastRunAt: null },
  };
}
export type RuleView = ReturnType<typeof ruleView>;

export async function listRules(ctx: Ctx) {
  authorize(ctx, 'automation:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const rules = await db.automationRule.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const since = new Date(Date.now() - 7 * 86_400_000);
    const grouped = await db.automationRun.groupBy({
      by: ['ruleId', 'status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return rules.map((r) => {
      const mine = grouped.filter((g) => g.ruleId === r.id);
      const count = (status: string) => mine.find((g) => g.status === status)?._count._all ?? 0;
      const lastRunAt = mine.reduce<Date | null>(
        (latest, g) =>
          g._max.createdAt && (!latest || g._max.createdAt > latest) ? g._max.createdAt : latest,
        null,
      );
      return ruleView(r, {
        runs: mine.reduce((sum, g) => sum + g._count._all, 0),
        done: count('DONE'),
        skipped: count('SKIPPED'),
        failed: count('FAILED'),
        pending: count('PENDING') + count('RUNNING'),
        lastRunAt,
      });
    });
  });
}

export async function createRule(ctx: Ctx, input: unknown) {
  authorize(ctx, 'automation:manage');
  const rule = validateRule(input);
  return withTenant(ctx.tenantId, async (db) => {
    if ((await db.automationRule.count()) >= MAX_RULES) {
      throw conflict(`A workspace can have at most ${MAX_RULES} rules. Delete one you no longer need.`);
    }
    const created = await db.automationRule.create({
      data: {
        name: rule.name,
        isActive: rule.isActive,
        trigger: rule.trigger,
        conditions: rule.conditions as Prisma.InputJsonValue,
        actions: rule.actions as unknown as Prisma.InputJsonValue,
        createdById: ctx.userId,
      } as Prisma.AutomationRuleUncheckedCreateInput,
    });
    await audit(db, ctx, 'automation.created', 'automation_rule', created.id, undefined, {
      name: rule.name,
      trigger: rule.trigger,
      isActive: rule.isActive,
    });
    return ruleView(created);
  });
}

export async function updateRule(ctx: Ctx, id: string, patch: RulePatch) {
  authorize(ctx, 'automation:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const current = await db.automationRule.findFirst({ where: { id } });
    if (!current) throw notFound('Rule');
    const trigger = patch.trigger ?? current.trigger;
    const merged = validateRule({
      name: patch.name ?? current.name,
      isActive: patch.isActive ?? current.isActive,
      trigger,
      // Another trigger starts from empty conditions: the old ones belong to the old trigger.
      conditions: patch.conditions ?? (trigger === current.trigger ? current.conditions : {}),
      actions: patch.actions ?? current.actions,
    });
    await db.automationRule.updateMany({
      where: { id },
      data: {
        name: merged.name,
        isActive: merged.isActive,
        trigger: merged.trigger,
        conditions: merged.conditions as Prisma.InputJsonValue,
        actions: merged.actions as unknown as Prisma.InputJsonValue,
      },
    });
    await audit(
      db,
      ctx,
      'automation.updated',
      'automation_rule',
      id,
      { name: current.name, isActive: current.isActive, trigger: current.trigger },
      { name: merged.name, isActive: merged.isActive, trigger: merged.trigger },
    );
    const fresh = await db.automationRule.findFirstOrThrow({ where: { id } });
    return ruleView(fresh);
  });
}

/** Deletes the rule and its run log (the audit log keeps a record that it existed). */
export async function deleteRule(ctx: Ctx, id: string) {
  authorize(ctx, 'automation:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const current = await db.automationRule.findFirst({ where: { id } });
    if (!current) throw notFound('Rule');
    const runs = await db.automationRun.deleteMany({ where: { ruleId: id } });
    await db.automationRule.deleteMany({ where: { id } });
    await audit(db, ctx, 'automation.deleted', 'automation_rule', id, {
      name: current.name,
      trigger: current.trigger,
      runsRemoved: runs.count,
    });
    return { id };
  });
}

/** Adds the starter rules this workspace doesn't have yet (all switched on). Safe to repeat. */
export async function installStarterRules(ctx: Ctx) {
  authorize(ctx, 'automation:manage');
  return withTenant(ctx.tenantId, async (db) => {
    const have = new Set(
      (
        await db.automationRule.findMany({
          where: { starterKey: { not: null } },
          select: { starterKey: true },
        })
      ).map((r) => r.starterKey),
    );
    const missing = STARTER_RULES.map((r) => r.key).filter((k) => !have.has(k));
    if (missing.length > 0) {
      const room = MAX_RULES - (await db.automationRule.count());
      if (room < missing.length)
        throw conflict('There is not enough room for the starter rules. Delete some rules first.');
      await db.automationRule.createMany({
        data: starterRuleRows(ctx.tenantId, ctx.userId, missing) as Prisma.AutomationRuleCreateManyInput[],
        skipDuplicates: true,
      });
      await audit(db, ctx, 'automation.starter_installed', 'automation_rule', null, undefined, {
        added: missing,
      });
    }
    return { added: missing.length, total: STARTER_RULES.length };
  });
}

// ── Run log ──────────────────────────────────────────────────────────────────

interface RunResult {
  summary?: string;
  error?: string;
  actions?: { type: string; outcome: string; detail: string }[];
}

export async function listRuns(ctx: Ctx, q: z.output<typeof runListQuerySchema>) {
  authorize(ctx, 'automation:manage');
  const cursor = decodeCursor(q.cursor);
  return withTenant(ctx.tenantId, async (db) => {
    const rows = await db.automationRun.findMany({
      where: {
        ...(q.ruleId ? { ruleId: q.ruleId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...afterCursor(cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: { rule: { select: { name: true } } },
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map((r) => {
        const result = (r.result ?? {}) as RunResult;
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          ruleId: r.ruleId,
          ruleName: r.rule.name,
          event: r.event,
          status: r.status,
          summary: result.summary ?? result.error ?? null,
          actions: result.actions ?? [],
          /** The person the event was about, and where to find the lead. */
          subject: typeof payload['name'] === 'string' ? payload['name'] : null,
          leadId: typeof payload['leadId'] === 'string' ? payload['leadId'] : null,
          webLeadId: typeof payload['webLeadId'] === 'string' ? payload['webLeadId'] : null,
          attempts: r.attempts,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt,
        };
      }),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  });
}
export type RunView = Awaited<ReturnType<typeof listRuns>>['items'][number];
