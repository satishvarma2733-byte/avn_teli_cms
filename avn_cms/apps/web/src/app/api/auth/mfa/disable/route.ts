import { disableMfa } from '@avn-cms/auth';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';

const schema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});

/** Turning MFA off requires a current code, so a stolen session alone can't remove it. */
export const POST = route(
  { access: 'principal', limit: 10, bucket: 'auth-mfa' },
  async ({ req, principal }) => {
    const { code } = await jsonBody(req, schema);
    if (!(await disableMfa(principal.userId, code)))
      return errorResponse('VALIDATION_ERROR', 'That code is not valid.');
    return ok({ enabled: false });
  },
);
