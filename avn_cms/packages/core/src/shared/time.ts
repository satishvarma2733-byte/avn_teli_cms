/** Tenant-timezone day boundaries ("today" means the agency's day, not the server's). */

export const DEFAULT_TZ = 'Asia/Kolkata';

/** Offset (ms) of `tz` from UTC at instant `at`. */
function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** [start, end) of the calendar day containing `at` in `tz`, as UTC instants. */
export function dayBounds(tz: string = DEFAULT_TZ, at: Date = new Date()): { start: Date; end: Date } {
  const offset = tzOffsetMs(tz, at);
  const local = new Date(at.getTime() + offset);
  const midnightLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const start = new Date(midnightLocalAsUtc - offset);
  const end = new Date(start.getTime() + 24 * 3_600_000);
  return { start, end };
}

/** A YYYY-MM-DD date in `tz` → [start, end) UTC instants for that whole day. */
export function dateRange(tz: string, from?: string, to?: string): { gte?: Date; lt?: Date } {
  const out: { gte?: Date; lt?: Date } = {};
  if (from) out.gte = dayBounds(tz, new Date(`${from}T12:00:00Z`)).start;
  if (to) out.lt = dayBounds(tz, new Date(`${to}T12:00:00Z`)).end;
  return out;
}

/** A wall-clock time in `tz` (e.g. "15-08-2026 10:30" in Asia/Kolkata) → the UTC instant. */
export function localToUtc(tz: string, y: number, mo: number, d: number, h = 0, mi = 0): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (guess.getUTCMonth() !== mo - 1 || guess.getUTCDate() !== d) return null; // 31 Feb etc.
  // Two passes handle a DST change between the guess and the real instant.
  let t = guess.getTime() - tzOffsetMs(tz, guess);
  t = guess.getTime() - tzOffsetMs(tz, new Date(t));
  return new Date(t);
}

export function tenantTimezone(settings: unknown): string {
  const tz = (settings as { timezone?: unknown } | null)?.timezone;
  if (typeof tz === 'string') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      /* invalid tz in settings */
    }
  }
  return DEFAULT_TZ;
}
