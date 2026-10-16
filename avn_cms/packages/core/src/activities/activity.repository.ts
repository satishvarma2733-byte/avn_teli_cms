import type { ActivityType, Direction, Prisma, TenantDb } from '@avn-cms/db';

/** Append-only timeline writer (the database grants the app INSERT/SELECT only). */
export function recordActivity(
  db: TenantDb,
  entry: {
    studentId: string;
    leadId?: string | null;
    type: ActivityType;
    actorId?: string | null;
    summary: string;
    payload?: Prisma.InputJsonValue;
    channel?: string | null;
    direction?: Direction | null;
  },
) {
  return db.activity.create({
    data: {
      studentId: entry.studentId,
      leadId: entry.leadId ?? null,
      type: entry.type,
      actorId: entry.actorId ?? null,
      summary: entry.summary.slice(0, 500),
      payload: entry.payload ?? {},
      channel: entry.channel ?? null,
      direction: entry.direction ?? null,
    } as Prisma.ActivityUncheckedCreateInput,
  });
}

export function listTimeline(db: TenantDb, where: Prisma.ActivityWhereInput, limit: number) {
  return db.activity.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      type: true,
      summary: true,
      payload: true,
      channel: true,
      direction: true,
      actorId: true,
      leadId: true,
      createdAt: true,
    },
  });
}
