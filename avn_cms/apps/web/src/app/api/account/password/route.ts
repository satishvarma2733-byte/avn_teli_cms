import { changePassword, passwordSchema } from '@avn-cms/auth';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';

const schema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.').max(128),
  newPassword: passwordSchema,
});

export const POST = route(
  { access: 'principal', limit: 10, bucket: 'account-password' },
  async ({ req, principal }) => {
    const dto = await jsonBody(req, schema);
    const changed = await changePassword({
      userId: principal.userId,
      currentSessionId: principal.sessionId,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
    });
    if (!changed)
      return errorResponse('VALIDATION_ERROR', 'Your current password is incorrect.', {
        fields: { currentPassword: 'Incorrect password.' },
      });
    return ok({ changed: true, otherSessionsSignedOut: true });
  },
);
