import { confirmMfa } from '@avn-cms/auth';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';

const schema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});

/** Step 2: turns it on and returns the one-time recovery codes (shown once). */
export const POST = route(
  { access: 'principal', allowMfaSetup: true, limit: 10, bucket: 'auth-mfa' },
  async ({ req, principal }) => {
    const { code } = await jsonBody(req, schema);
    const confirmed = await confirmMfa(principal.userId, principal.sessionId, code);
    if (!confirmed) {
      return errorResponse(
        'VALIDATION_ERROR',
        'That code is not valid. Make sure your phone’s clock is correct and try again.',
      );
    }
    return ok({ enabled: true, recoveryCodes: confirmed.recoveryCodes });
  },
);
