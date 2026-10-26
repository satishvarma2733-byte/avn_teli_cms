import { leads } from '@avn-cms/core';
import { leadListQuerySchema, studentCreateSchema } from '@avn-cms/core/schemas';

import { jsonBody, ok, query, route } from '@/lib/api';

/** The Student/Lead workspace list (server-side filter, sort, search, keyset pagination). */
export const GET = route({}, async ({ req, ctx }) => {
  const result = await leads.listLeads(ctx, query(req, leadListQuerySchema));
  return ok(result.items, {
    nextCursor: result.nextCursor,
    ...(result.total !== undefined ? { total: result.total, totalExact: result.totalExact } : {}),
  });
});

/** Add Student: creates the student and their first lead (with dedupe on phone). */
export const POST = route({ action: 'student:create', limit: 60 }, async ({ req, ctx }) => {
  const dto = await jsonBody(req, studentCreateSchema);
  return ok(await leads.createStudent(ctx, dto), undefined, 201);
});
