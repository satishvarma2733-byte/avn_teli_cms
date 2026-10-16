import { revokeOwnSession } from '@avn-cms/auth';
import { z } from 'zod';

import { errorResponse, ok, route } from '@/lib/api';

export const DELETE = route({ access: 'principal', limit: 20 }, async ({ principal, params }) => {
  const id = z.uuid().parse(params['id']);
  if (!(await revokeOwnSession(principal.userId, id)))
    return errorResponse('NOT_FOUND', 'Session not found.');
  return ok({ id });
});
