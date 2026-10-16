import { confirmMfa } from '@avn-cms/auth';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';

const schema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});

export const POST = route(
  { access: 'principal', limit: 10, bucket: 'auth-mfa' },
  async ({ req, principal }) => {
    const { code } = await jsonBody(req, schema);
    if (!(await confirmMfa(principal.userId, principal.sessionId, code))) {
      return errorResponse(
        'VALIDATION_ERROR',
        'That code is not valid. Make sure your phone’s clock is correct and try again.',
      );
    }
    return ok({ enabled: true });
  },
);
