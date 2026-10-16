import { leads } from '@avn-cms/core';
import { studentUpdateSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

const id = z.uuid();

export const PATCH = route({ limit: 120 }, async ({ req, ctx, params }) => {
  const dto = await jsonBody(req, studentUpdateSchema);
  return ok(await leads.updateStudent(ctx, id.parse(params['id']), dto));
});

/** Soft delete (admin only). */
export const DELETE = route({ limit: 60 }, async ({ ctx, params }) =>
  ok(await leads.deleteStudent(ctx, id.parse(params['id']))),
);
