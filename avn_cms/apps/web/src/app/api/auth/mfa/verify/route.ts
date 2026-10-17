import { verifyMfaForSession } from '@avn-cms/auth';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';
import { landingPath } from '@/lib/session';

// A 6-digit code from the app, or a recovery code (XXXXX-XXXXX).
const schema = z.object({
  code: z.string().trim().min(6, 'Enter your code.').max(20, 'That code is too long.'),
});

export const POST = route(
  { access: 'principal', allowPendingMfa: true, limit: 10, bucket: 'auth-mfa' },
  async ({ req, principal }) => {
    const { code } = await jsonBody(req, schema);
    const result = await verifyMfaForSession(principal.userId, principal.sessionId, code);
    if (!result.ok) {
      if (result.reason === 'LOCKED') {
        return errorResponse(
          'RATE_LIMITED',
          'Too many wrong codes. Wait a few minutes before trying again.',
          undefined,
          result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : undefined,
        );
      }
      return errorResponse('VALIDATION_ERROR', 'That code is not valid. Check your code and try again.');
    }
    return ok({
      redirectTo: principal.mfaSetupRequired ? '/login/mfa-setup' : landingPath(principal),
      usedRecoveryCode: result.method === 'recovery',
      recoveryCodesLeft: result.recoveryCodesLeft,
    });
  },
);
