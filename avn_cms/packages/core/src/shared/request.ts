import { isIP } from 'node:net';

/**
 * Who is calling, and where may we send them back to. Pure functions so the rules are tested
 * without a server.
 */

/**
 * The client's address, for rate limits, the audit log and the session list.
 *
 * `X-Forwarded-For` is a list that every proxy appends to, and the caller can start it with
 * anything. Only the entries added by proxies we run are trustworthy, so the address is taken
 * `trustedHops` places from the **right** (1 = the single load balancer in front of the app), never
 * from the left. With no trusted proxy (`0`, the default) the headers are ignored and every caller
 * shares the `local` address: limits then apply to the whole site rather than being bypassable.
 */
export function clientIpFrom(
  header: (name: string) => string | null | undefined,
  trustedHops: number,
): string {
  if (trustedHops <= 0) return 'local';
  const forwarded = (header('x-forwarded-for') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate =
    forwarded.length >= trustedHops
      ? forwarded[forwarded.length - trustedHops]
      : (forwarded[0] ?? header('x-real-ip')?.trim());
  return candidate && isIP(candidate) ? candidate : 'local';
}

const SIGNED_IN_AREAS = ['/app', '/platform'];

/**
 * The page to return to after signing in (`?next=`), or undefined when it is not one of ours.
 * Only a path inside the signed-in areas is accepted: no other site (`//host`, `/\host`,
 * `https://host`), no control characters, no backslashes (browsers read `/\` as `//`).
 */
export function safeNextPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return undefined;
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000- \u007f]/.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw, 'http://self.invalid');
  } catch {
    return undefined;
  }
  if (url.origin !== 'http://self.invalid') return undefined;
  const inArea = SIGNED_IN_AREAS.some((area) => url.pathname === area || url.pathname.startsWith(`${area}/`));
  return inArea ? raw : undefined;
}
