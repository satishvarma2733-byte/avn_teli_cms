import { NextResponse, type NextRequest } from 'next/server';

/**
 * Runs before every page request: per-request CSP nonce, and an optimistic redirect to
 * /login when there is no session cookie at all. Real session checks happen on the server
 * in every layout and route handler (this is not the authorization layer).
 */
const SESSION_COOKIE = 'avn_session';

/**
 * Where the browser sends uploaded documents (presigned URLs for Cloudflare R2, or the local
 * S3-compatible server). It is the only extra origin the page may connect to.
 */
function storageOrigin(): string {
  const endpoint =
    process.env.R2_ENDPOINT ||
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  try {
    return endpoint ? new URL(endpoint).origin : '';
  } catch {
    return '';
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const protectedArea = pathname.startsWith('/app') || pathname.startsWith('/platform');
  if (protectedArea && !request.cookies.get(SESSION_COOKIE)) {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const storage = storageOrigin();
  const https = (process.env.APP_URL ?? '').startsWith('https://');
  // Scripts and style elements need the per-request nonce or our own origin; only style *attributes*
  // (charts and the virtual table set them) are allowed inline. Everything else is same-origin, and
  // nothing may be framed, embedded, run as a worker or play media.
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'nonce-${nonce}'${isDev ? ` 'unsafe-inline'` : ''}`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self'${storage ? ` ${storage}` : ''}${isDev ? ' ws:' : ''}`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `worker-src 'none'`,
    `media-src 'none'`,
    `manifest-src 'self'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  // Sign-in cookies and everything behind them only ever travel over HTTPS (browsers remember this).
  if (https) response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
