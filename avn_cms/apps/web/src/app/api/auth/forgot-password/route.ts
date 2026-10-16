import { forgotPasswordSchema, requestPasswordReset } from '@avn-cms/auth';
import { sendPasswordResetEmail } from '@avn-cms/core';

import { jsonBody, ok, route } from '@/lib/api';

/** Always answers the same way, so it never reveals whether an account exists. */
export const POST = route({ access: 'public', limit: 5, bucket: 'auth-forgot' }, async ({ req }) => {
  const input = await jsonBody(req, forgotPasswordSchema);
  const issued = await requestPasswordReset(input);
  if (issued) {
    const mail = await sendPasswordResetEmail(issued.email, issued.name, issued.token);
    if (!mail.sent)
      console.error(
        JSON.stringify({ level: 'error', msg: 'password reset email not sent', reason: mail.reason }),
      );
  }
  return ok({ message: 'If that account exists, we have emailed a link to reset the password.' });
});
