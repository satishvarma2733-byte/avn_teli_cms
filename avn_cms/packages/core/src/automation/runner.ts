import { withTenant, type Prisma, type TenantDb } from '@avn-cms/db';
import { z } from 'zod';

import type { JobPayload } from '../jobs/queue';
import { loadSettings } from '../tenants/settings';
import { runAction, type ActionOutcome, type RunContext } from './actions';
import {
  actionSchema,
  conditionSchemas,
  DEFAULT_OVERDUE_MINUTES,
  OVERDUE_LOOKBACK_DAYS,
  UNCONTACTED_LOOKBACK_DAYS,
  type OverdueEventPayload,
  type UncontactedEventPayload,
} from './definitions';
import { queueRuns } from './emit';
import { ruleMatches } from './match';

/** A run that fails for a temporary reason is tried again, up to this many times in all. */
export const MAX_RUN_ATTEMPTS = 3;
/** A run still PENDING after this long was never handed to the queue (or the hand-over was lost). */
const STALE_PENDING_MS = 60_000;
/** A run still RUNNING after this long belonged to a worker that died. */
const STALE_RUNNING_MS = 10 * 60_000;
export const RUN_RETENTION_DAYS = 90;
const BATCH = 200;

/** A problem retrying won't fix (the rule itself is broken). */
class PermanentRunError extends Error {}

const summarize = (outcomes: ActionOutcome[]): string =>
  outcomes
    .map((o) => (o.outcome === 'skipped' ? `Skipped: ${o.detail}` : o.detail))
    .join('. ')
    .slice(0, 500);

async function finish(
  db: TenantDb,
  runId: string,
  status: 'DONE' | 'SKIPPED',
  summary: string,
  actions: ActionOutcome[],
  now: Date,
) {
  await db.automationRun.updateMany({
    where: { id: runId, status: 'RUNNING' },
    data: {
      status,
      finishedAt: now,
      result: { summary, actions } as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * The job: carry out one run. The rule is read again here, so a rule that was turned off after the
 * run was recorded does nothing. All the run's actions and its result are one transaction: they
 * all happen, or none do and the run is tried again.
 */
export async function runAutomation({ tenantId, jobId }: JobPayload): Promise<void> {
  const claimed = await withTenant(tenantId, async (db) => {
    const res = await db.automationRun.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (res.count !== 1) return null; // already taken, or finished
    return db.automationRun.findFirstOrThrow({
      where: { id: jobId },
      select: { id: true, ruleId: true, payload: true, attempts: true },
    });
  });
  if (!claimed) return;

  try {
    await withTenant(tenantId, async (db) => {
      const now = new Date();
      const rule = await db.automationRule.findFirst({ where: { id: claimed.ruleId } });
      if (!rule || !rule.isActive) {
        await finish(db, claimed.id, 'SKIPPED', 'The rule was turned off before it ran.', [], now);
        return;
      }
      const actions = z.array(actionSchema).safeParse(rule.actions);
      if (!actions.success) throw new PermanentRunError('The rule’s actions are not valid. Edit the rule.');
      const context: RunContext = {
        db,
        now,
        trigger: rule.trigger,
        ruleName: rule.name,
        payload: (claimed.payload ?? {}) as Record<string, unknown>,
        assigned: [],
      };
      const outcomes: ActionOutcome[] = [];
      for (const action of actions.data) outcomes.push(await runAction(action, context));
      const anyDone = outcomes.some((o) => o.outcome === 'done');
      await finish(db, claimed.id, anyDone ? 'DONE' : 'SKIPPED', summarize(outcomes), outcomes, now);
    });
  } catch (err) {
    // Everything the actions did was rolled back with the transaction.
    const permanent = err instanceof PermanentRunError;
    const message = permanent ? err.message : 'The rule could not be run (a temporary problem).';
    if (!permanent) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'automation run failed',
          runId: claimed.id,
          attempt: claimed.attempts,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    const final = permanent || claimed.attempts >= MAX_RUN_ATTEMPTS;
    await withTenant(tenantId, (db) =>
      db.automationRun.updateMany({
        where: { id: claimed.id, status: 'RUNNING' },
        data: final
          ? { status: 'FAILED', finishedAt: new Date(), result: { summary: message, error: message } }
          : { status: 'PENDING', result: { error: message } },
      }),
    );
  }
}

// ── The worker's sweep ───────────────────────────────────────────────────────

export interface SweepResult {
  uncontacted: number;
  overdue: number;
  requeued: number;
  recovered: number;
  purged: number;
}

interface UncontactedRow {
  id: string;
  student_id: string;
  name: string;
  source_id: string | null;
}
interface OverdueRow {
  id: string;
  lead_id: string;
  assignee_id: string;
  priority: 'NORMAL' | 'HOT';
  scheduled_at: Date;
  student_id: string;
  source_id: string | null;
  name: string;
}

/**
 * One workspace's housekeeping, run by the worker every couple of minutes:
 *  - time-based rules: finds leads nobody has contacted, and calls that are overdue, and records a
 *    run for each (once per rule per lead or call, even if the sweep sees it again);
 *  - queues runs that were recorded but never handed over, and recovers runs a dead worker left
 *    RUNNING;
 *  - removes old finished runs.
 * Time-based rules only look at recent records (days, not months), so turning one on never floods
 * people about old ones.
 */
export async function sweepAutomation(tenantId: string, now = new Date()): Promise<SweepResult> {
  return withTenant(
    tenantId,
    async (db) => {
      const result: SweepResult = { uncontacted: 0, overdue: 0, requeued: 0, recovered: 0, purged: 0 };
      const queued = new Set<string>();

      const rules = await db.automationRule.findMany({
        where: { isActive: true, trigger: { in: ['LEAD_UNCONTACTED', 'FOLLOWUP_OVERDUE'] } },
        select: { id: true, trigger: true, conditions: true },
      });
      const settings = rules.some((r) => r.trigger === 'LEAD_UNCONTACTED') ? await loadSettings(db) : null;

      for (const rule of rules) {
        if (rule.trigger === 'LEAD_UNCONTACTED') {
          const parsed = conditionSchemas.LEAD_UNCONTACTED.safeParse(rule.conditions ?? {});
          if (!parsed.success) continue;
          const minutes = parsed.data.minutes ?? settings?.uncontactedMinutes ?? 30;
          const cutoff = new Date(now.getTime() - minutes * 60_000);
          const windowStart = new Date(now.getTime() - UNCONTACTED_LOOKBACK_DAYS * 86_400_000);
          const sources = parsed.data.sourceIds ?? null;
          const rows = await db.$queryRaw<UncontactedRow[]>`
            SELECT l.id, l.student_id, s.name, l.source_id
            FROM leads l JOIN students s ON s.id = l.student_id
            WHERE l.tenant_id = app_tenant_id() AND l.deleted_at IS NULL
              AND l.stage = 'NEW' AND l.last_contacted_at IS NULL
              AND l.created_at <= ${cutoff} AND l.created_at >= ${windowStart}
              AND (${sources === null}::boolean OR l.source_id = ANY(${sources ?? []}::uuid[]))
              AND NOT EXISTS (
                SELECT 1 FROM automation_runs r
                WHERE r.tenant_id = l.tenant_id AND r.rule_id = ${rule.id}::uuid AND r.dedupe_key = l.id::text)
            ORDER BY l.created_at ASC
            LIMIT ${BATCH}`;
          const events = rows
            .map((r): UncontactedEventPayload => ({
              leadId: r.id,
              studentId: r.student_id,
              name: r.name,
              sourceId: r.source_id,
              minutes,
            }))
            .filter((payload) => ruleMatches('LEAD_UNCONTACTED', rule.conditions, payload));
          result.uncontacted += await record(
            db,
            rule.id,
            'LEAD_UNCONTACTED',
            events,
            (p) => p.leadId,
            (p) => p.leadId,
            queued,
          );
        } else {
          const parsed = conditionSchemas.FOLLOWUP_OVERDUE.safeParse(rule.conditions ?? {});
          if (!parsed.success) continue;
          const minutesOverdue = parsed.data.minutesOverdue ?? DEFAULT_OVERDUE_MINUTES;
          const cutoff = new Date(now.getTime() - minutesOverdue * 60_000);
          const windowStart = new Date(now.getTime() - OVERDUE_LOOKBACK_DAYS * 86_400_000);
          const priority = parsed.data.priority ?? null;
          const rows = await db.$queryRaw<OverdueRow[]>`
            SELECT f.id, f.lead_id, f.assignee_id, f.priority::text AS priority, f.scheduled_at,
                   l.student_id, l.source_id, s.name
            FROM follow_ups f
              JOIN leads l ON l.id = f.lead_id
              JOIN students s ON s.id = l.student_id
            WHERE f.tenant_id = app_tenant_id() AND f.completed_at IS NULL AND l.deleted_at IS NULL
              AND f.scheduled_at <= ${cutoff} AND f.scheduled_at >= ${windowStart}
              AND (${priority === null}::boolean OR f.priority::text = ${priority ?? ''})
              AND NOT EXISTS (
                SELECT 1 FROM automation_runs r
                WHERE r.tenant_id = f.tenant_id AND r.rule_id = ${rule.id}::uuid AND r.dedupe_key = f.id::text)
            ORDER BY f.scheduled_at ASC
            LIMIT ${BATCH}`;
          const events = rows
            .map((r): OverdueEventPayload => ({
              followUpId: r.id,
              leadId: r.lead_id,
              studentId: r.student_id,
              name: r.name,
              sourceId: r.source_id,
              assigneeId: r.assignee_id,
              priority: r.priority,
              scheduledAt: r.scheduled_at.toISOString(),
              minutesOverdue: Math.max(0, Math.floor((now.getTime() - r.scheduled_at.getTime()) / 60_000)),
            }))
            .filter((payload) => ruleMatches('FOLLOWUP_OVERDUE', rule.conditions, payload));
          result.overdue += await record(
            db,
            rule.id,
            'FOLLOWUP_OVERDUE',
            events,
            (p) => p.followUpId,
            (p) => p.followUpId,
            queued,
          );
        }
      }

      // Runs that were recorded but never handed to the queue.
      const stale = await db.automationRun.findMany({
        where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - STALE_PENDING_MS) } },
        select: { id: true },
        take: BATCH,
      });
      for (const run of stale) queued.add(run.id);

      // Runs a dead worker left RUNNING: tried again, or failed once they have had their attempts.
      const abandoned = new Date(now.getTime() - STALE_RUNNING_MS);
      const gaveUp = await db.automationRun.updateMany({
        where: { status: 'RUNNING', startedAt: { lt: abandoned }, attempts: { gte: MAX_RUN_ATTEMPTS } },
        data: {
          status: 'FAILED',
          finishedAt: now,
          result: { summary: 'The run was cut off and used up its attempts.', error: 'cut off' },
        },
      });
      const recovered = await db.automationRun.findMany({
        where: { status: 'RUNNING', startedAt: { lt: abandoned }, attempts: { lt: MAX_RUN_ATTEMPTS } },
        select: { id: true },
        take: BATCH,
      });
      if (recovered.length > 0) {
        await db.automationRun.updateMany({
          where: { id: { in: recovered.map((r) => r.id) }, status: 'RUNNING' },
          data: { status: 'PENDING' },
        });
        for (const run of recovered) queued.add(run.id);
      }
      result.recovered = recovered.length + gaveUp.count;
      result.requeued = queued.size;

      const purged = await db.automationRun.deleteMany({
        where: {
          createdAt: { lt: new Date(now.getTime() - RUN_RETENTION_DAYS * 86_400_000) },
          status: { in: ['DONE', 'SKIPPED', 'FAILED'] },
        },
      });
      result.purged = purged.count;

      queueRuns(tenantId, [...queued]);
      return result;
    },
    { timeoutMs: 60_000 },
  );
}

/** Records one PENDING run per event for a rule (skipping any it already has) and remembers the new ids. */
async function record<P extends object>(
  db: TenantDb,
  ruleId: string,
  trigger: 'LEAD_UNCONTACTED' | 'FOLLOWUP_OVERDUE',
  events: P[],
  entityOf: (p: P) => string,
  keyOf: (p: P) => string,
  queued: Set<string>,
): Promise<number> {
  if (events.length === 0) return 0;
  const created = await db.automationRun.createManyAndReturn({
    data: events.map((p) => ({
      ruleId,
      event: trigger,
      entityId: entityOf(p),
      status: 'PENDING',
      payload: p as unknown as Prisma.InputJsonValue,
      dedupeKey: keyOf(p),
    })) as Prisma.AutomationRunCreateManyInput[],
    skipDuplicates: true,
    select: { id: true },
  });
  for (const run of created) queued.add(run.id);
  return created.length;
}
