import { regenerateRecoveryCodes } from '@avn-cms/auth';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';

const schema = z.object({
  code: z.string().trim().min(6, 'Enter your code.').max(20, 'That code is too long.'),
});

/** A new set of recovery codes (the old ones stop working). Needs a current code. Shown once. */
export const POST = route(
  { access: 'principal', limit: 10, bucket: 'auth-mfa' },
  async ({ req, principal }) => {
    const { code } = await jsonBody(req, schema);
    const result = await regenerateRecoveryCodes(principal.userId, code);
    if (!result.ok) {
      return result.reason === 'LOCKED'
        ? errorResponse(
            'RATE_LIMITED',
            'Too many wrong codes. Wait a few minutes before trying again.',
            undefined,
            result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : undefined,
          )
        : errorResponse('VALIDATION_ERROR', 'That code is not valid.');
    }
    return ok({ recoveryCodes: result.recoveryCodes });
  },
);
