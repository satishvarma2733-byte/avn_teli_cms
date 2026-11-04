import { users } from '@avn-cms/core';
import { mfaResetSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/**
 * An admin clears the two-step verification of someone who lost both their authenticator and their
 * recovery codes. Needs the admin's password again and a reason; the person is signed out and told.
 */
export const POST = route(
  { action: 'user:resetMfa', limit: 10, bucket: 'user-mfa-reset' },
  async ({ req, ctx, params }) => {
    const dto = await jsonBody(req, mfaResetSchema);
    return ok(await users.adminResetMfa(ctx, z.uuid().parse(params['id']), dto));
  },
);
