import { describe, expect, it } from 'vitest';

import { decrypt, encrypt, sha256 } from './crypto';
import { base32Decode, base32Encode, totpAt, verifyTotp } from './totp';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B test secret (ASCII "12345678901234567890"), SHA-1, 8-digit codes truncated to 6.
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 SHA-1 vectors (last 6 digits)', () => {
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpAt(secret, 1_111_111_109_000)).toBe('081804');
    expect(totpAt(secret, 1_234_567_890_000)).toBe('005924');
    expect(totpAt(secret, 2_000_000_000_000)).toBe('279037');
  });

  it('accepts ±1 step and rejects older codes and junk', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('aVn CMS secret bytes');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe('crypto helpers', () => {
  it('encrypts with AES-GCM and detects tampering', () => {
    const sealed = encrypt('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decrypt(sealed)).toBe('JBSWY3DPEHPK3PXP');
    const [iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt([iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('hashes tokens deterministically', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
