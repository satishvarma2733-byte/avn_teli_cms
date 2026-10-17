import type { Prisma, TenantDb } from '@avn-cms/db';

import { recordActivity } from '../activities/activity.repository';
import { pickRoundRobin, setAssignment, userNames } from '../assignments/assignment.repository';
import { recomputeNextCall } from '../followups/followup.service';
import { STAGE_LABEL } from '../schemas';
import type {
  ActionType,
  AutomationAction,
  AutomationTriggerCode,
  LeadEventPayload,
  OverdueEventPayload,
  StageEventPayload,
  UncontactedEventPayload,
  WebLeadEventPayload,
} from './definitions';

/**
 * What each action does. Every action runs inside the run's one transaction, so a run's actions
 * happen together or not at all. An action that finds nothing to do (the lead already has a
 * counselor, nobody to tell) reports `skipped` with the reason; that is normal, not a failure.
 *
 * Actions never emit events, so a rule can't start another rule.
 */
export interface RunContext {
  db: TenantDb;
  now: Date;
  trigger: AutomationTriggerCode;
  ruleName: string;
  /** What happened (the event payload), as recorded when the run was created. */
  payload: Record<string, unknown>;
  /** People this run has assigned so far, so a later "notify" can tell them. */
  assigned: string[];
}

export interface ActionOutcome {
  type: ActionType;
  outcome: 'done' | 'skipped';
  detail: string;
}

const done = (type: ActionType, detail: string): ActionOutcome => ({ type, outcome: 'done', detail });
const skipped = (type: ActionType, detail: string): ActionOutcome => ({ type, outcome: 'skipped', detail });

const names = (list: string[]): string =>
  list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;

const readLead = (c: RunContext) => c.payload as unknown as LeadEventPayload;

/** {name}, {stage}, {minutes}, {country} in a notification's text. Unknown names become empty. */
function fill(template: string, c: RunContext): string {
  const p = c.payload as Record<string, unknown>;
  const vars: Record<string, string> = {
    name: String(p['name'] ?? ''),
    stage: p['to'] ? STAGE_LABEL[p['to'] as keyof typeof STAGE_LABEL] : '',
    minutes: p['minutes'] !== undefined ? String(p['minutes']) : '',
    country: String(p['country'] ?? ''),
  };
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] ?? '');
}

async function adminIds(db: TenantDb): Promise<string[]> {
  const admins = await db.user.findMany({
    where: { roleCode: 'TENANT_ADMIN', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return admins.map((a) => a.id);
}

async function leadOwners(db: TenantDb, leadId: string) {
  const rows = await db.leadAssignment.findMany({
    where: { leadId, isActive: true },
    select: { assigneeId: true, roleFunction: true },
  });
  return {
    counselor: rows.find((r) => r.roleFunction === 'COUNSELOR')?.assigneeId ?? null,
    telecaller: rows.find((r) => r.roleFunction === 'TELECALLER')?.assigneeId ?? null,
  };
}

async function liveLead(db: TenantDb, leadId: string) {
  return db.lead.findFirst({
    where: { id: leadId, deletedAt: null },
    select: { id: true, studentId: true, priority: true },
  });
}

// ── assign_round_robin ───────────────────────────────────────────────────────

async function assignInTurn(
  action: Extract<AutomationAction, { type: 'assign_round_robin' }>,
  c: RunContext,
): Promise<ActionOutcome> {
  const { db } = c;
  const label = action.role === 'COUNSELOR' ? 'counselor' : 'telecaller';
  if (c.trigger === 'WEB_LEAD_CREATED') {
    const p = c.payload as unknown as WebLeadEventPayload;
    const row = await db.webLead.findFirst({
      where: { id: p.webLeadId },
      select: { routedToId: true, status: true },
    });
    if (!row) return skipped(action.type, 'The web lead no longer exists.');
    if (row.routedToId) return skipped(action.type, 'It was already routed to someone.');
    if (row.status === 'CONVERTED') return skipped(action.type, 'It was already converted.');
    const id = await pickRoundRobin(db, 'COUNSELOR');
    if (!id) return skipped(action.type, 'There is no active counselor to route it to.');
    await db.webLead.updateMany({
      where: { id: p.webLeadId, routedToId: null },
      data: { routedToId: id, routedAt: c.now },
    });
    c.assigned.push(id);
    const who = (await userNames(db, [id])).get(id) ?? 'a counselor';
    return done(action.type, `Routed to ${who}`);
  }

  const p = readLead(c);
  const lead = await liveLead(db, p.leadId);
  if (!lead) return skipped(action.type, 'The lead no longer exists.');
  const current = await db.leadAssignment.findFirst({
    where: { leadId: lead.id, roleFunction: action.role, isActive: true },
    select: { id: true },
  });
  if (current) return skipped(action.type, `The lead already has a ${label}.`);
  const id = await pickRoundRobin(db, action.role);
  if (!id) return skipped(action.type, `There is no active ${label} to assign.`);
  await setAssignment(db, lead.id, action.role, id, null);
  c.assigned.push(id);
  const who = (await userNames(db, [id])).get(id) ?? `a ${label}`;
  await recordActivity(db, {
    studentId: lead.studentId,
    leadId: lead.id,
    type: 'ASSIGNMENT',
    summary: `${who} assigned as ${label} by automation “${c.ruleName}”`,
    payload: { assigneeId: id, role: action.role },
  });
  return done(action.type, `Assigned ${who} as ${label}`);
}

// ── notify ───────────────────────────────────────────────────────────────────

async function recipientsFor(
  to: Extract<AutomationAction, { type: 'notify' }>['to'],
  c: RunContext,
): Promise<string[]> {
  const { db } = c;
  if (to === 'admins') return adminIds(db);
  if (to === 'assignee') {
    const id = (c.payload as unknown as OverdueEventPayload).assigneeId;
    return id ? [id] : [];
  }
  if (c.trigger === 'WEB_LEAD_CREATED') {
    // A web lead has no owners yet; "assigned" is whoever this run just routed it to (or earlier).
    if (c.assigned.length > 0) return c.assigned;
    const p = c.payload as unknown as WebLeadEventPayload;
    const row = await db.webLead.findFirst({ where: { id: p.webLeadId }, select: { routedToId: true } });
    return row?.routedToId ? [row.routedToId] : [];
  }
  const owners = await leadOwners(db, readLead(c).leadId);
  if (to === 'counselor') return owners.counselor ? [owners.counselor] : [];
  if (to === 'telecaller') return owners.telecaller ? [owners.telecaller] : [];
  if (c.assigned.length > 0) return c.assigned;
  return [owners.counselor, owners.telecaller].filter((x): x is string => Boolean(x));
}

async function notify(
  action: Extract<AutomationAction, { type: 'notify' }>,
  c: RunContext,
): Promise<ActionOutcome> {
  const { db } = c;
  const recipients = [...new Set(await recipientsFor(action.to, c))];
  if (recipients.length === 0) return skipped(action.type, 'There was nobody to tell.');
  const isWebLead = c.trigger === 'WEB_LEAD_CREATED';
  const entityId = isWebLead ? (c.payload as unknown as WebLeadEventPayload).webLeadId : readLead(c).leadId;
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      type: 'automation.notify',
      title: fill(action.title, c).slice(0, 200),
      body: action.body ? fill(action.body, c).slice(0, 500) : null,
      entityType: isWebLead ? 'web_lead' : 'lead',
      entityId,
    })) as Prisma.NotificationCreateManyInput[],
  });
  const told = await userNames(db, recipients);
  return done(action.type, `Told ${names(recipients.map((id) => told.get(id) ?? 'someone'))}`);
}

// ── escalate ─────────────────────────────────────────────────────────────────

const duration = (minutes: number): string => {
  if (minutes >= 2880) return `${Math.floor(minutes / 1440)} days`;
  if (minutes >= 120) return `${Math.floor(minutes / 60)} hours`;
  return `${minutes} minutes`;
};

async function escalate(c: RunContext): Promise<ActionOutcome> {
  const { db } = c;
  const p = c.payload as unknown as OverdueEventPayload;
  const call = await db.followUp.findFirst({
    where: { id: p.followUpId },
    select: { id: true, assigneeId: true, leadId: true, completedAt: true, escalatedAt: true },
  });
  if (!call) return skipped('escalate', 'The call no longer exists.');
  if (call.completedAt) return skipped('escalate', 'The call was made in the meantime.');
  if (call.escalatedAt) return skipped('escalate', 'It was already escalated.');
  const lead = await liveLead(db, call.leadId);
  if (!lead) return skipped('escalate', 'The lead no longer exists.');
  const admins = await adminIds(db);
  const to = admins[0] ?? null;
  await db.followUp.updateMany({
    where: { id: call.id, escalatedAt: null },
    data: { escalatedAt: c.now, escalatedTo: to },
  });
  const recipients = [...new Set([call.assigneeId, ...admins])];
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      type: 'followup.escalated',
      title: `Overdue call: ${p.name}`,
      body: `This call is ${duration(p.minutesOverdue)} overdue.`,
      entityType: 'lead',
      entityId: call.leadId,
    })) as Prisma.NotificationCreateManyInput[],
  });
  await recordActivity(db, {
    studentId: lead.studentId,
    leadId: lead.id,
    type: 'SYSTEM',
    summary: `Overdue call escalated${to ? ' to the admin' : ''} by automation “${c.ruleName}”`,
    payload: { followUpId: call.id },
  });
  return done(
    'escalate',
    `Escalated; told ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}`,
  );
}

// ── schedule_followup ────────────────────────────────────────────────────────

async function scheduleFollowUp(
  action: Extract<AutomationAction, { type: 'schedule_followup' }>,
  c: RunContext,
): Promise<ActionOutcome> {
  const { db } = c;
  const p = readLead(c) as UncontactedEventPayload | StageEventPayload;
  const lead = await liveLead(db, p.leadId);
  if (!lead) return skipped(action.type, 'The lead no longer exists.');
  const open = await db.followUp.findFirst({
    where: { leadId: lead.id, completedAt: null },
    select: { id: true },
  });
  if (open) return skipped(action.type, 'The lead already has a call scheduled.');
  const owners = await leadOwners(db, lead.id);
  const assigneeId =
    action.assignee === 'counselor'
      ? owners.counselor
      : action.assignee === 'telecaller'
        ? owners.telecaller
        : (owners.telecaller ?? owners.counselor);
  if (!assigneeId) return skipped(action.type, 'Nobody is assigned to take the call.');
  const at = new Date(c.now.getTime() + action.afterMinutes * 60_000);
  await db.followUp.create({
    data: {
      leadId: lead.id,
      scheduledAt: at,
      assigneeId,
      priority: lead.priority,
      createdById: null,
    } as Prisma.FollowUpUncheckedCreateInput,
  });
  await recomputeNextCall(db, lead.id);
  await recordActivity(db, {
    studentId: lead.studentId,
    leadId: lead.id,
    type: 'SYSTEM',
    summary: `Call scheduled by automation “${c.ruleName}”`,
    payload: { scheduledAt: at.toISOString(), assigneeId },
  });
  const who = (await userNames(db, [assigneeId])).get(assigneeId) ?? 'the owner';
  return done(action.type, `Scheduled a call for ${who}`);
}

// ── stop_reminders ───────────────────────────────────────────────────────────

/**
 * Removes the lead's open (not yet made) follow-up calls. They are deleted rather than "completed",
 * so they don't show up as calls that were made in the reports; the run log and the lead's timeline
 * record that they were removed.
 */
async function stopReminders(c: RunContext): Promise<ActionOutcome> {
  const { db } = c;
  const lead = await liveLead(db, readLead(c).leadId);
  if (!lead) return skipped('stop_reminders', 'The lead no longer exists.');
  const removed = await db.followUp.deleteMany({ where: { leadId: lead.id, completedAt: null } });
  if (removed.count === 0) return skipped('stop_reminders', 'There were no open reminders.');
  await recomputeNextCall(db, lead.id);
  await recordActivity(db, {
    studentId: lead.studentId,
    leadId: lead.id,
    type: 'SYSTEM',
    summary: `${removed.count} reminder${removed.count === 1 ? '' : 's'} stopped by automation “${c.ruleName}”`,
    payload: { removed: removed.count },
  });
  return done('stop_reminders', `Stopped ${removed.count} reminder${removed.count === 1 ? '' : 's'}`);
}

/** Runs one action. An unexpected error propagates, rolling back the whole run. */
export function runAction(action: AutomationAction, c: RunContext): Promise<ActionOutcome> {
  switch (action.type) {
    case 'assign_round_robin':
      return assignInTurn(action, c);
    case 'notify':
      return notify(action, c);
    case 'escalate':
      return escalate(c);
    case 'schedule_followup':
      return scheduleFollowUp(action, c);
    case 'stop_reminders':
      return stopReminders(c);
  }
}
