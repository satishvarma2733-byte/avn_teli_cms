import { describe, expect, it } from 'vitest';

import { isGuessablePassword, passwordSchema } from './password';

describe('password rules', () => {
  const problems = (p: string) => {
    const parsed = passwordSchema.safeParse(p);
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  };

  it('accepts a long password that mixes letters with numbers or symbols', () => {
    expect(problems('Horse-Battery-Staple-42')).toEqual([]);
    expect(problems('purple.giraffe.7.lantern')).toEqual([]);
  });

  it('still needs 12 characters and a mix', () => {
    expect(problems('Sh0rt!pass')).toContain('Use at least 12 characters.');
    expect(problems('onlylettersinhere')).toContain('Mix letters with numbers or symbols.');
    expect(problems('1234567890123')).toContain('Mix letters with numbers or symbols.');
    expect(problems('x'.repeat(129) + '1')).toContain('Use at most 128 characters.');
  });

  it('turns away passwords that are among the first guesses, however they are dressed up', () => {
    for (const weak of [
      'Password-12345!',
      'password1234',
      'PASSWORD@2026!!',
      'Qwertyuiop123!',
      'Administrator#1',
      'Welcome-2026-ok',
      'Iloveyou12345',
      'Changeme-2026!',
      'aaaaaaaaaaaa1',
      'abcabcabcabc1',
      'Hyderabad@2026',
      'avncms-2026-ok1',
    ]) {
      expect(isGuessablePassword(weak), weak).toBe(true);
      expect(problems(weak), weak).toContain(
        'That password is too easy to guess. Choose something less common.',
      );
    }
  });

  it('does not turn away ordinary passwords that merely contain a common word', () => {
    for (const fine of ['Correct-Horse-Battery-9', 'My-Password-Manager-Key-77', 'blue.test.of.strength.4']) {
      expect(isGuessablePassword(fine), fine).toBe(false);
    }
  });
});
