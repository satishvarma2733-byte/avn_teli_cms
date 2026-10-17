import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

/** OWASP Argon2id baseline: 19 MiB, 2 iterations, 1 lane. Argon2id is the library default. */
const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Words that make a password easy to guess however many digits or symbols follow them. Compared with
 * the password's letters only, lowercased ("Password-2026!" becomes "password").
 */
const COMMON_BASES = [
  'password',
  'passw',
  'passwort',
  'qwerty',
  'qwertyuiop',
  'qwertyuiopasdfghjkl',
  'asdfghjkl',
  'zxcvbnm',
  'administrator',
  'admin',
  'letmein',
  'welcome',
  'iloveyou',
  'changeme',
  'trustno',
  'dragon',
  'monkey',
  'football',
  'baseball',
  'superman',
  'princess',
  'sunshine',
  'master',
  'shadow',
  'abc',
  'abcdefgh',
  'abcdefghij',
  'abcdefghijkl',
  'india',
  'hyderabad',
  'krishna',
  'sairam',
  'jaishreeram',
  'avncms',
  'avn',
  'ewings',
  'leadxp',
  'secret',
  'login',
  'default',
  'guest',
  'user',
  'test',
];

/** True for passwords that pass the length and mix rules but are still among the first guesses. */
export function isGuessablePassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (new Set(lower).size <= 2) return true; // "aaaaaaaaaaaa1", "121212121212a"
  const letters = lower.replace(/[^a-z]/g, '');
  const common = COMMON_BASES.some(
    (base) => letters === base || (letters.startsWith(base) && letters.length <= base.length + 2),
  );
  // A short pattern repeated ("abcabcabcabc", with or without digits after it).
  const repeated = (text: string) => text.length >= 6 && /^(.{1,4})\1{2,}$/.test(text);
  return common || repeated(lower) || repeated(letters);
}

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.')
  .refine((p) => /[a-zA-Z]/.test(p) && /[^a-zA-Z]/.test(p), 'Mix letters with numbers or symbols.')
  .refine(
    (p) => !isGuessablePassword(p),
    'That password is too easy to guess. Choose something less common.',
  );

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
