import { intakeCredentials } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

/** New secret now; the old one keeps working for 24 hours. */
export const POST = route({ action: 'intakeCredential:manage', limit: 20 }, async ({ ctx, params }) =>
  ok(await intakeCredentials.rotateCredential(ctx, z.uuid().parse(params['id']))),
);
