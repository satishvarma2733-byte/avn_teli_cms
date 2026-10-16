import type { Prisma, TenantDb } from '@avn-cms/db';

/** All lead/student database access for the workspace (the only file here that touches the client). */

export const leadListSelect = {
  id: true,
  stage: true,
  isPotential: true,
  priority: true,
  interestCountry: true,
  interestCourse: true,
  nextCallAt: true,
  lastContactedAt: true,
  createdAt: true,
  updatedAt: true,
  student: {
    select: { id: true, name: true, phoneE164: true, email: true, town: true, district: true, state: true },
  },
  source: { select: { id: true, code: true, label: true } },
  assignments: {
    where: { isActive: true },
    select: { roleFunction: true, assignee: { select: { id: true, name: true } } },
  },
} satisfies Prisma.LeadSelect;

export type LeadListRow = Prisma.LeadGetPayload<{ select: typeof leadListSelect }>;

export function findLeads(
  db: TenantDb,
  where: Prisma.LeadWhereInput,
  orderBy: Prisma.LeadOrderByWithRelationInput[],
  take: number,
) {
  return db.lead.findMany({ where, orderBy, take, select: leadListSelect });
}

export function countLeads(db: TenantDb, where: Prisma.LeadWhereInput) {
  return db.lead.count({ where });
}

/** Lead + student + active assignee ids: what every ownership check needs. */
export function findLeadForAccess(db: TenantDb, leadId: string) {
  return db.lead.findFirst({
    where: { id: leadId, deletedAt: null },
    include: {
      student: true,
      source: { select: { id: true, code: true, label: true } },
      assignments: { where: { isActive: true }, select: { assigneeId: true, roleFunction: true } },
    },
  });
}
export type LeadForAccess = NonNullable<Awaited<ReturnType<typeof findLeadForAccess>>>;

export function findStudentByPhone(db: TenantDb, phoneE164: string, excludeStudentId?: string) {
  return db.student.findFirst({
    where: { phoneE164, deletedAt: null, ...(excludeStudentId ? { id: { not: excludeStudentId } } : {}) },
    select: {
      id: true,
      name: true,
      leads: { where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}

export function countStudentsByEmail(db: TenantDb, email: string, excludeStudentId?: string) {
  return db.student.count({
    where: { email, deletedAt: null, ...(excludeStudentId ? { id: { not: excludeStudentId } } : {}) },
  });
}

export function findSource(db: TenantDb, sourceId: string) {
  return db.leadSource.findFirst({ where: { id: sourceId, isActive: true } });
}

/** Everything the lead detail page shows, read in sequence (one transaction connection). */
export async function leadDetailRelations(db: TenantDb, leadId: string, studentId: string) {
  const assignments = await db.leadAssignment.findMany({
    where: { leadId },
    orderBy: { assignedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      roleFunction: true,
      isActive: true,
      assignedAt: true,
      endedAt: true,
      assigneeId: true,
      assignedById: true,
    },
  });
  const followUps = await db.followUp.findMany({
    where: { leadId },
    orderBy: [{ completedAt: { sort: 'desc', nulls: 'first' } }, { scheduledAt: 'asc' }],
    take: 30,
    select: {
      id: true,
      scheduledAt: true,
      disposition: true,
      priority: true,
      outcomeNote: true,
      completedAt: true,
      isOverdue: true,
      assigneeId: true,
    },
  });
  const notes = await db.note.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, body: true, authorId: true, createdAt: true },
  });
  const history = await db.leadStatusHistory.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      fromStage: true,
      toStage: true,
      changedById: true,
      note: true,
      reason: true,
      createdAt: true,
    },
  });
  const otherLeads = await db.lead.findMany({
    where: { deletedAt: null, studentId },
    select: { id: true, stage: true, createdAt: true, interestCountry: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  return [assignments, followUps, notes, history, otherLeads] as const;
}
