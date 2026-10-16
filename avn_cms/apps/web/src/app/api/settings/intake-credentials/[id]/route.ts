import { intakeCredentials } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

/** Revoke. */
export const DELETE = route({ limit: 20 }, async ({ ctx, params }) =>
  ok(await intakeCredentials.revokeCredential(ctx, z.uuid().parse(params['id']))),
);
