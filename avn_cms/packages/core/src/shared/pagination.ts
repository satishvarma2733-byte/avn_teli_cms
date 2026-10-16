import { z } from 'zod';

import { invalid } from './errors';

/** Keyset pagination on (created_at, id) — never OFFSET on large tables (ARCHITECTURE §8). */
export interface Cursor {
  createdAt: string;
  id: string;
}

export const pageQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string | undefined): Cursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      throw new Error('bad cursor');
    }
    return parsed;
  } catch {
    throw invalid('Invalid cursor.');
  }
}

/** Prisma `where` fragment for "rows after this cursor" in (createdAt desc, id desc) order. */
export function afterCursor(cursor: Cursor | undefined) {
  if (!cursor) return {};
  const at = new Date(cursor.createdAt);
  return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] };
}

/**
 * Keyset cursor on any (timestamp column, id) pair, either direction. The cursor records
 * which sort it belongs to, so a cursor from one sort can't be replayed against another.
 */
export interface Keyset {
  s: string;
  v: string;
  id: string;
}

export function encodeKeyset(sort: string, value: Date, id: string): string {
  return Buffer.from(JSON.stringify({ s: sort, v: value.toISOString(), id })).toString('base64url');
}

export function decodeKeyset(cursor: string | undefined, sort: string): Keyset | undefined {
  if (!cursor) return undefined;
  try {
    const k = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Keyset;
    if (k.s !== sort || typeof k.id !== 'string' || Number.isNaN(Date.parse(k.v))) throw new Error('bad');
    return k;
  } catch {
    throw invalid('Invalid cursor.');
  }
}

/** `where` fragment for rows after `k` when ordering by (field, id) in `dir`. */
export function keysetWhere(field: string, dir: 'asc' | 'desc', k: Keyset | undefined) {
  if (!k) return {};
  const at = new Date(k.v);
  const op = dir === 'desc' ? 'lt' : 'gt';
  return { OR: [{ [field]: { [op]: at } }, { [field]: at, id: { [op]: k.id } }] };
}

/** Fetch limit+1 rows, return `limit` and the next cursor if there was one more. */
export function pageOf<T extends { createdAt: Date; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
