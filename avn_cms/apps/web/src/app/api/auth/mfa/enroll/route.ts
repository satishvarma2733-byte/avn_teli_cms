import { beginMfaEnrollment, MfaAlreadyEnabled } from '@avn-cms/auth';
import QRCode from 'qrcode';

import { errorResponse, ok, route } from '@/lib/api';

/** Step 1: a new secret + QR code. MFA turns on only after /confirm with a valid code. */
export const POST = route(
  { access: 'principal', limit: 10, bucket: 'auth-mfa-enroll' },
  async ({ principal }) => {
    try {
      const { secret, otpauth } = await beginMfaEnrollment(principal.userId);
      const svg = await QRCode.toString(otpauth, { type: 'svg', margin: 1, width: 192 });
      return ok({ secret, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
    } catch (err) {
      if (err instanceof MfaAlreadyEnabled) return errorResponse('CONFLICT', err.message);
      throw err;
    }
  },
);
