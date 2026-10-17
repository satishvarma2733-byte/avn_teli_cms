import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';

import { proxy } from './proxy';

/** The headers every page gets: script and style rules with a fresh nonce, and HTTPS-only when we are on HTTPS. */
const get = (path: string, cookie?: string) =>
  proxy(new NextRequest(`http://localhost:3300${path}`, cookie ? { headers: { cookie } } : {}));
const directives = (csp: string) =>
  Object.fromEntries(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values];
    }),
  );

describe('the page security policy', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env['APP_URL'] = env['APP_URL'];
    delete process.env['R2_ENDPOINT'];
    delete process.env['R2_ACCOUNT_ID'];
  });

  it('allows scripts only from our own files and a nonce made for this request', () => {
    const a = directives(get('/login').headers.get('content-security-policy')!);
    const b = directives(get('/login').headers.get('content-security-policy')!);
    const nonce = (d: typeof a) => d['script-src']!.find((v) => v.startsWith("'nonce-"))!;
    expect(nonce(a)).toMatch(/^'nonce-[A-Za-z0-9+/=]{20,}'$/);
    expect(nonce(a)).not.toBe(nonce(b));
    expect(a['script-src']).toEqual(expect.arrayContaining(["'self'", "'strict-dynamic'"]));
    expect(a['script-src']).not.toContain("'unsafe-inline'");
    expect(a['script-src']).not.toContain("'unsafe-eval'");
  });

  it('allows style elements only with the nonce (style attributes are the one inline exception)', () => {
    const csp = directives(get('/login').headers.get('content-security-policy')!);
    expect(csp['style-src']).not.toContain("'unsafe-inline'");
    expect(csp['style-src']!.some((v) => v.startsWith("'nonce-"))).toBe(true);
    expect(csp['style-src-attr']).toEqual(["'unsafe-inline'"]);
  });

  it('shuts everything else: no framing, plugins, workers, media, other forms or other base address', () => {
    const csp = directives(get('/login').headers.get('content-security-policy')!);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['frame-src']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['worker-src']).toEqual(["'none'"]);
    expect(csp['media-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['img-src']).toEqual(["'self'", 'blob:', 'data:']);
  });

  it('lets the page talk to its own server and, for uploads, to the document store and nowhere else', () => {
    expect(directives(get('/login').headers.get('content-security-policy')!)['connect-src']).toEqual([
      "'self'",
    ]);
    process.env['R2_ENDPOINT'] = 'https://abc123.r2.cloudflarestorage.com/some/path';
    expect(directives(get('/login').headers.get('content-security-policy')!)['connect-src']).toEqual([
      "'self'",
      'https://abc123.r2.cloudflarestorage.com',
    ]);
  });

  it('adds HTTPS-only rules when the app runs on HTTPS, and not on plain http (local development)', () => {
    process.env['APP_URL'] = 'http://localhost:3300';
    const plain = get('/login');
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    expect(plain.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');

    process.env['APP_URL'] = 'https://crm.example.com';
    const secure = get('/login');
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(secure.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
  });

  it('sends people who are not signed in from the app to sign-in, remembering where they were going', () => {
    const res = get('/app/leads');
    expect(res.status).toBe(307);
    const target = new URL(res.headers.get('location')!);
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.get('next')).toBe('/app/leads');
    expect(get('/platform').status).toBe(307);
    expect(get('/app/leads', 'avn_session=abc').status).toBe(200);
    expect(get('/login').status).toBe(200);
  });
});
