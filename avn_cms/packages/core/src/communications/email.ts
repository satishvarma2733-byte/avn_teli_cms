import { getConfig } from '@avn-cms/config';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outgoing email (communications module). Without SMTP_HOST the message is not sent and
 * the caller is told so — nothing pretends an email went out.
 */
let transporter: Transporter | null | undefined;

function transport(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const c = getConfig();
  if (!c.SMTP_HOST || !c.SMTP_PORT) return (transporter = null);
  transporter = nodemailer.createTransport({
    host: c.SMTP_HOST,
    port: c.SMTP_PORT,
    secure: c.SMTP_PORT === 465,
    ...(c.SMTP_USER ? { auth: { user: c.SMTP_USER, pass: c.SMTP_PASS ?? '' } } : {}),
  });
  return transporter;
}

export interface MailResult {
  sent: boolean;
  reason?: 'NOT_CONFIGURED' | 'SEND_FAILED';
}

export async function sendMail(
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<MailResult> {
  const t = transport();
  if (!t) return { sent: false, reason: 'NOT_CONFIGURED' };
  try {
    await t.sendMail({ from: getConfig().SMTP_FROM, to, subject, text, ...(html ? { html } : {}) });
    return { sent: true };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'email send failed',
        subject,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { sent: false, reason: 'SEND_FAILED' };
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function sendPasswordResetEmail(to: string, name: string, token: string): Promise<MailResult> {
  const link = `${getConfig().APP_URL}/reset-password/${encodeURIComponent(token)}`;
  const text = `Hi ${name},\n\nUse this link to set a new aVn CMS password. It works once and expires in 1 hour:\n${link}\n\nIf you didn't ask for this, you can ignore this email.`;
  const html = `<p>Hi ${escape(name)},</p><p>Use this link to set a new aVn CMS password. It works once and expires in 1 hour:</p><p><a href="${escape(link)}">Set a new password</a></p><p>If you didn't ask for this, you can ignore this email.</p>`;
  return sendMail(to, 'Reset your aVn CMS password', text, html);
}
