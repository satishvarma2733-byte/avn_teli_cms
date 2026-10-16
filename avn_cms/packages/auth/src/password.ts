import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

/** OWASP Argon2id baseline: 19 MiB, 2 iterations, 1 lane. Argon2id is the library default. */
const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.')
  .refine((p) => /[a-zA-Z]/.test(p) && /[^a-zA-Z]/.test(p), 'Mix letters with numbers or symbols.');

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Hash used to keep login timing the same whether or not the account exists
 * (no user-enumeration through response time).
 */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(await dummyHash, password);
}
