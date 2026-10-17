import { describe, expect, it } from 'vitest';

import { generateRecoveryCode, normalizeRecoveryCode } from './mfa';
import { base32Encode, totpAt, totpStep } from './totp';

describe('recovery codes', () => {
  it('are ten characters from an alphabet without look-alikes, shown as two groups of five', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    }
    expect(new Set(Array.from({ length: 500 }, generateRecoveryCode)).size).toBe(500);
  });

  it('are read back the same however they are typed', () => {
    expect(normalizeRecoveryCode('ABCDE-FGHJK')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('  abcdefghjk ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode(generateRecoveryCode())).toHaveLength(10);
  });

  it('are refused when they cannot be one', () => {
    for (const bad of [
      '',
      'short',
      'ABCDE-FGHJ',
      'ABCDE-FGHJKL',
      'ABCDE-FGHJ0',
      'ABCDE-FGHJI',
      '12345-67890',
    ]) {
      expect(normalizeRecoveryCode(bad), bad).toBeNull();
    }
  });
});

describe('totpStep', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 1000 / 30);

  it('says which 30-second step a code belongs to, so a spent step can be refused', () => {
    expect(totpStep(secret, totpAt(secret, now), now)).toBe(step);
    expect(totpStep(secret, totpAt(secret, now - 30_000), now)).toBe(step - 1);
    expect(totpStep(secret, totpAt(secret, now + 30_000), now)).toBe(step + 1);
  });

  it('is null for old codes and junk', () => {
    expect(totpStep(secret, totpAt(secret, now - 90_000), now)).toBeNull();
    expect(totpStep(secret, '000000', now)).toBeNull();
    expect(totpStep(secret, 'abcdef', now)).toBeNull();
    expect(totpStep(secret, '12345', now)).toBeNull();
  });
});
