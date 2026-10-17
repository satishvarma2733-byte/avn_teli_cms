import { beginMfaEnrollment, MfaAlreadyEnabled } from '@avn-cms/auth';
import QRCode from 'qrcode';
import { z } from 'zod';

import { errorResponse, jsonBody, ok, route } from '@/lib/api';

const schema = z.object({ currentPassword: z.string().min(1, 'Enter your password.').max(128) });

/**
 * Step 1: needs the account password; returns a new secret + QR code. MFA turns on only after
 * /confirm with a valid code.
 */
export const POST = route(
  { access: 'principal', allowMfaSetup: true, limit: 10, bucket: 'auth-mfa-enroll' },
  async ({ req, principal }) => {
    const { currentPassword } = await jsonBody(req, schema);
    try {
      const begun = await beginMfaEnrollment(principal.userId, currentPassword);
      if (!begun)
        return errorResponse('VALIDATION_ERROR', 'Your password is incorrect.', {
          fields: { currentPassword: 'Incorrect password.' },
        });
      const svg = await QRCode.toString(begun.otpauth, { type: 'svg', margin: 1, width: 192 });
      return ok({
        secret: begun.secret,
        qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      });
    } catch (err) {
      if (err instanceof MfaAlreadyEnabled) return errorResponse('CONFLICT', err.message);
      throw err;
    }
  },
);
