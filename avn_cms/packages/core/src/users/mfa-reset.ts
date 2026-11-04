import { confirmPassword } from '@avn-cms/auth';

import { sendMail } from '../communications/email';
import { AppError, invalid } from '../shared/errors';
import { rateLimit } from '../shared/rate-limit';

/**
 * What the workspace route and the platform route share when an administrator resets someone's
 * two-step verification: asking for the administrator's password again, and telling the person.
 */

/** Password checks an administrator may make for resets within the window, whether right or wrong. */
const PASSWORD_CHECKS = 5;
const WINDOW_SECONDS = 15 * 60;

/**
 * The acting administrator types their own password again. A stolen session alone is then not enough
 * to strip anyone's second factor, and a thief cannot use the form to guess the password: after
 * five tries in fifteen minutes it refuses until the window ends.
 */
export async function requireOwnPassword(userId: string, password: string): Promise<void> {
  const limit = await rateLimit(`mfa-reset-password:${userId}`, PASSWORD_CHECKS, WINDOW_SECONDS);
  if (!limit.allowed) {
    throw new AppError(
      'RATE_LIMITED',
      `Too many tries. Wait ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s) before resetting anyone else’s two-step verification.`,
      { retryAfterSeconds: limit.retryAfterSeconds },
    );
  }
  if (!(await confirmPassword(userId, password))) {
    throw invalid('Your password is incorrect.', { fields: { currentPassword: 'Incorrect password.' } });
  }
}

/** The words the person is told, in the app and by email. `by` is a name, or 'aVn CMS support'. */
export function resetNotice(by: string, reenrolmentRequired: boolean) {
  const next = reenrolmentRequired
    ? 'You will be asked to set it up again the next time you sign in.'
    : 'You can turn it back on from My account.';
  const body = `${by} reset your two-step verification and signed you out of every device. ${next} If you did not ask for this, tell your workspace admin right away.`;
  return {
    title: 'Your two-step verification was reset',
    body,
    subject: 'Your aVn CMS two-step verification was reset',
    email: (name: string) => `Hi ${name},\n\n${body}`,
  };
}

/** Emails the notice. Never throws: the reset has already happened. */
export async function emailResetNotice(
  person: { name: string; email: string },
  by: string,
  reenrolmentRequired: boolean,
): Promise<boolean> {
  const notice = resetNotice(by, reenrolmentRequired);
  return (await sendMail(person.email, notice.subject, notice.email(person.name))).sent;
}
