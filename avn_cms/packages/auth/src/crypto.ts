import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { getConfig } from '@avn-cms/config';

/** 256-bit random token, URL-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function key(): Buffer {
  return Buffer.from(getConfig().ENCRYPTION_KEY, 'base64').subarray(0, 32);
}

/** AES-256-GCM. Output: base64url(iv).base64url(tag).base64url(ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
