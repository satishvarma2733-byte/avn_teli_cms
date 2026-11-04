import { platform } from '@avn-cms/core';
import { mfaResetSchema } from '@avn-cms/core/schemas';
import { z } from 'zod';

import { jsonBody, ok, route } from '@/lib/api';

/**
 * A super admin clears the two-step verification of an agency admin who lost both their authenticator and
 * their recovery codes and has no other admin to ask. Needs the super admin's password again and a reason.
 */
export const POST = route(
  { roles: ['SUPER_ADMIN'], access: 'principal', limit: 10, bucket: 'platform-mfa-reset' },
  async ({ req, principal, params, ip, userAgent }) => {
    const dto = await jsonBody(req, mfaResetSchema);
    return ok(
      await platform.resetAdminMfa(
        principal,
        z.uuid().parse(params['id']),
        z.uuid().parse(params['userId']),
        dto,
        { ip, ...(userAgent ? { userAgent } : {}) },
      ),
    );
  },
);
