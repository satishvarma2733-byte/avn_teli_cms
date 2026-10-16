import { listStuckScans } from '@avn-cms/core';

import { ok, route } from '@/lib/api';

/** Files whose virus scan did not finish (blocked until it does). Admins only. */
export const GET = route({}, async ({ ctx }) => ok(await listStuckScans(ctx)));
