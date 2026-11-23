import { describe, expect, it } from 'vitest';

import { studentCreateSchema } from './schemas';

/** What a person is told when they leave a required box empty: plain words, never a Zod default. */
function messages(input: unknown): Record<string, string> {
  const parsed = studentCreateSchema.safeParse(input);
  if (parsed.success) return {};
  return Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]));
}

describe('adding a student: required fields left out', () => {
  // The form drops boxes that are empty, so the server receives the key missing, not an empty string.
  it('says what to fill in when the fields are missing altogether', () => {
    expect(messages({})).toEqual({
      name: 'Enter the student’s name.',
      phone: 'Enter a phone number.',
      sourceId: 'Choose a source.',
    });
  });

  it('says the same when the fields are present but empty', () => {
    expect(messages({ name: '  ', phone: '', sourceId: '' })).toMatchObject({
      name: 'Enter the student’s name.',
      phone: 'Enter a phone number.',
    });
  });

  it('accepts a complete student', () => {
    expect(
      messages({ name: 'Asha', phone: '9876543210', sourceId: '7d0c6f5e-2b0a-4a51-9c1e-1f2a3b4c5d6e' }),
    ).toEqual({});
  });
});
