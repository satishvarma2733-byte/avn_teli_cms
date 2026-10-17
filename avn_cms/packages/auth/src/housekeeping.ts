import { ownerDb } from '@avn-cms/db/owner';

const DAY = 86_400_000;

/**
 * Removes sign-in records nobody can use any more: sessions that ended (revoked or expired) more than
 * 30 days ago, and reset links that were used or expired more than 7 days ago. Recent ones stay for
 * a while so "where was I signed in" and incident questions can still be answered.
 */
export async function purgeAuthRecords(now = new Date()): Promise<{ sessions: number; resetTokens: number }> {
  const db = ownerDb();
  const sessionCutoff = new Date(now.getTime() - 30 * DAY);
  const tokenCutoff = new Date(now.getTime() - 7 * DAY);
  const sessions = await db.session.deleteMany({
    where: { OR: [{ revokedAt: { lt: sessionCutoff } }, { expiresAt: { lt: sessionCutoff } }] },
  });
  const resetTokens = await db.passwordResetToken.deleteMany({
    where: { OR: [{ usedAt: { lt: tokenCutoff } }, { expiresAt: { lt: tokenCutoff } }] },
  });
  return { sessions: sessions.count, resetTokens: resetTokens.count };
}
