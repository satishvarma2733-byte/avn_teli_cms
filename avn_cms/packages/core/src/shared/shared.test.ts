import { describe, expect, it } from 'vitest';

import { AppError } from './errors';
import { afterCursor, decodeCursor, encodeCursor, pageOf } from './pagination';
import { toE164 } from './phone';

describe('toE164', () => {
  it('normalises Indian numbers written different ways', () => {
    for (const raw of ['9876543210', '+91 98765 43210', '098765-43210', '91 9876543210', '+919876543210']) {
      expect(toE164(raw)).toBe('+919876543210');
    }
  });
  it('rejects junk and too-short numbers', () => {
    for (const raw of ['', '12345', 'abcdefghij', '0000000000', '+91 12345']) expect(toE164(raw)).toBeNull();
  });
  it('keeps foreign numbers that carry a country code', () => {
    expect(toE164('+996 555 123 456')).toBe('+996555123456');
  });
});

describe('cursor pagination', () => {
  it('round-trips a cursor and builds the keyset filter', () => {
    const row = { createdAt: new Date('2026-10-01T10:00:00Z'), id: '7d0c6f5e-2b0a-4a51-9c1e-1f2a3b4c5d6e' };
    const decoded = decodeCursor(encodeCursor(row));
    expect(decoded).toEqual({ createdAt: '2026-10-01T10:00:00.000Z', id: row.id });
    expect(afterCursor(decoded)).toEqual({
      OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }],
    });
  });
  it('rejects tampered cursors with VALIDATION_ERROR', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from('{"createdAt":"x","id":1}').toString('base64url'))).toThrow(
      AppError,
    );
  });
  it('returns limit rows and a next cursor only when there is more', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ createdAt: new Date(3000 - i), id: `id${i}` }));
    expect(pageOf(rows, 2).items).toHaveLength(2);
    expect(pageOf(rows, 2).nextCursor).not.toBeNull();
    expect(pageOf(rows, 3).nextCursor).toBeNull();
  });
});
