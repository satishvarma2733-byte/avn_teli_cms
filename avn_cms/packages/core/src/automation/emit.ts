import { afterCommit, type Prisma, type TenantDb } from '@avn-cms/db';

import { enqueue } from '../jobs/queue';
import type { AutomationTriggerCode, EventPayloads } from './definitions';
import { ruleMatches } from './match';

/**
 * Something happened that rules may care about (a web lead arrived, a stage changed, …).
 *
 * Inside the transaction of the change that caused it, this finds the active rules for the trigger
 * whose conditions fit, and records one PENDING run for each. The change and its runs therefore
 * commit together: a run can never exist for a change that rolled back, and a change can never lose
 * its runs. Only after the commit are the runs handed to the background job (`automation.run`); if
 * that hand-over fails, the worker's sweep finds the pending runs and queues them.
 *
 * A rule that is off is not in the query, so it never gets a run. `payload` is built only when some
 * rule is active, so workspaces without automations pay for one indexed query.
 *
 * Returns how many runs were recorded.
 */
export async function emitAutomation<T extends AutomationTriggerCode>(
  db: TenantDb,
  tenantId: string,
  event: {
    trigger: T;
    /** The record the event is about (a web lead, lead or follow-up). */
    entityId: string;
    /** Identifies this event for one rule: the same event is never run twice by the same rule. */
    dedupeKey: string;
    payload: () => EventPayloads[T] | Promise<EventPayloads[T]>;
  },
): Promise<number> {
  const rules = await db.automationRule.findMany({
    where: { trigger: event.trigger, isActive: true },
    select: { id: true, conditions: true },
  });
  if (rules.length === 0) return 0;
  const payload = await event.payload();
  const matching = rules.filter((r) => ruleMatches(event.trigger, r.conditions, payload));
  if (matching.length === 0) return 0;
  const created = await db.automationRun.createManyAndReturn({
    data: matching.map((r) => ({
      ruleId: r.id,
      event: event.trigger,
      entityId: event.entityId,
      status: 'PENDING',
      payload: payload as unknown as Prisma.InputJsonValue,
      dedupeKey: event.dedupeKey,
    })) as unknown as Prisma.AutomationRunCreateManyInput[],
    skipDuplicates: true,
    select: { id: true },
  });
  queueRuns(
    tenantId,
    created.map((r) => r.id),
  );
  return created.length;
}

/** Hands pending runs to the job queue once the surrounding transaction has committed. */
export function queueRuns(tenantId: string, runIds: string[]): void {
  if (runIds.length === 0) return;
  afterCommit(async () => {
    for (const jobId of runIds) {
      try {
        await enqueue('automation.run', { tenantId, jobId });
      } catch (err) {
        // Not fatal: the run stays PENDING and the worker's sweep queues it again.
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'automation run could not be queued',
            runId: jobId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });
}
