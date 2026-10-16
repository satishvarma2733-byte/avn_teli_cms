import { verifyMfaForSession } from '@avn-cms/auth';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';
import { landingPath } from '@/lib/session';

const schema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});

export const POST = route(
  { access: 'principal', allowPendingMfa: true, limit: 10, bucket: 'auth-mfa' },
  async ({ req, principal }) => {
    const { code } = await jsonBody(req, schema);
    if (!(await verifyMfaForSession(principal.userId, principal.sessionId, code))) {
      return errorResponse(
        'VALIDATION_ERROR',
        'That code is not valid. Check your authenticator app and try again.',
      );
    }
    return ok({ redirectTo: landingPath(principal) });
  },
);
