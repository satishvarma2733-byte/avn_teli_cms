import { intakeCredentials } from '@avn-cms/core';
import { intakeCredentialCreateSchema } from '@avn-cms/core/schemas';

import { jsonBody, ok, route } from '@/lib/api';

export const GET = route({ action: 'intakeCredential:manage' }, async ({ ctx }) =>
  ok(await intakeCredentials.listCredentials(ctx)),
);

/** The secret is in this response only; it is never shown again. */
export const POST = route({ action: 'intakeCredential:manage', limit: 20 }, async ({ req, ctx }) => {
  const dto = await jsonBody(req, intakeCredentialCreateSchema);
  return ok(await intakeCredentials.createCredential(ctx, dto), undefined, 201);
});
