import { documents } from '@avn-cms/core';
import { z } from 'zod';

import { ok, route } from '@/lib/api';

/** The student's document checklist and their other documents. Counselors: own leads only. */
export const GET = route({}, async ({ ctx, params }) =>
  ok(await documents.getChecklist(ctx, z.uuid().parse(params['id']))),
);
