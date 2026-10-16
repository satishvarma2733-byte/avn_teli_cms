import { resetPassword, resetPasswordSchema } from '@avn-cms/auth';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';

export const POST = route({ access: 'public', limit: 10, bucket: 'auth-reset' }, async ({ req }) => {
  const input = await jsonBody(req, resetPasswordSchema);
  if (!(await resetPassword(input))) {
    return errorResponse('VALIDATION_ERROR', 'This reset link is invalid or has expired. Request a new one.');
  }
  return ok({ redirectTo: '/login?reset=1' });
});
