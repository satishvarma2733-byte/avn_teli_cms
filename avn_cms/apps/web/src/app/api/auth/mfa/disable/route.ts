import { disableMfa } from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';

const schema = z.object({
  code: z.string().trim().min(6, 'Enter your code.').max(20, 'That code is too long.'),
});

/**
 * Turning MFA off requires a current code (or a recovery code), so a stolen session alone can't
 * remove it, and it signs the other devices out. Roles that must use it can't turn it off.
 */
export const POST = route(
  { access: 'principal', limit: 10, bucket: 'auth-mfa' },
  async ({ req, principal }) => {
    if (getConfig().MFA_REQUIRED_ROLES.includes(principal.role))
      return errorResponse(
        'FORBIDDEN',
        'Your role has to use two-step verification, so it can’t be turned off.',
      );
    const { code } = await jsonBody(req, schema);
    const result = await disableMfa(principal.userId, principal.sessionId, code);
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
    return ok({ enabled: false });
  },
);
