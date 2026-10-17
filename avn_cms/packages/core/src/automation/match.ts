import {
  conditionSchemas,
  type AutomationTriggerCode,
  type EventPayloads,
  type OverdueEventPayload,
  type StageEventPayload,
  type WebLeadEventPayload,
} from './definitions';

/**
 * Does this event satisfy a rule's conditions? A rule whose stored conditions no longer parse (edited
 * by hand, or from an older version) never fires: doing nothing is safer than guessing.
 *
 * Time thresholds ("after 30 minutes", "24 hours overdue") are not checked here: the sweep that
 * finds those events applies them when it looks for candidates.
 */
export function ruleMatches<T extends AutomationTriggerCode>(
  trigger: T,
  rawConditions: unknown,
  payload: EventPayloads[T],
): boolean {
  const parsed = conditionSchemas[trigger].safeParse(rawConditions ?? {});
  if (!parsed.success) return false;
  const c = parsed.data as Record<string, unknown>;
  switch (trigger) {
    case 'WEB_LEAD_CREATED': {
      const p = payload as WebLeadEventPayload;
      const statuses = c['statuses'] as string[] | undefined;
      if (statuses && !statuses.includes(p.status)) return false;
      const sources = c['sourceIds'] as string[] | undefined;
      if (sources && !(p.sourceId && sources.includes(p.sourceId))) return false;
      const countries = c['countries'] as string[] | undefined;
      if (countries) {
        const wanted = countries.map((x) => x.trim().toLowerCase());
        if (!(p.country && wanted.includes(p.country.trim().toLowerCase()))) return false;
      }
      const min = c['minNeetScore'] as number | undefined;
      if (min !== undefined && !(p.neetScore !== null && p.neetScore >= min)) return false;
      return true;
    }
    case 'LEAD_UNCONTACTED': {
      const p = payload as EventPayloads['LEAD_UNCONTACTED'];
      const sources = c['sourceIds'] as string[] | undefined;
      return !sources || Boolean(p.sourceId && sources.includes(p.sourceId));
    }
    case 'FOLLOWUP_OVERDUE': {
      const p = payload as OverdueEventPayload;
      const priority = c['priority'] as string | undefined;
      return !priority || priority === p.priority;
    }
    case 'STAGE_CHANGED': {
      const p = payload as StageEventPayload;
      if (c['toStage'] !== p.to) return false;
      const from = c['fromStage'] as string | undefined;
      return !from || from === p.from;
    }
  }
}
