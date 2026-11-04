import { ownerDb } from '@avn-cms/db/owner';

import { burnPasswordCheck, verifyPassword } from './password';

/**
 * True when `password` is the person's current password. For sensitive actions that ask for it again
 * (a stolen session alone must not be enough). The caller limits how often it may be asked.
 */
export async function confirmPassword(userId: string, password: string): Promise<boolean> {
  const user = await ownerDb().user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) {
    await burnPasswordCheck(password);
    return false;
  }
  return verifyPassword(user.passwordHash, password);
}
