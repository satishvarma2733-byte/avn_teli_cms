import { documents } from '@avn-cms/core';
import { checklistReviewSchema, StudentDocType } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/** Verify or reject the file on a checklist item (or put it back to "uploaded"). */
export const PATCH = route({ limit: 120 }, async ({ req, ctx, params }) => {
  const dto = await jsonBody(req, checklistReviewSchema);
  return ok(
    await documents.reviewChecklistItem(
      ctx,
      z.uuid().parse(params['id']),
      z.enum(StudentDocType).parse(params['docType']),
      dto,
    ),
  );
});
