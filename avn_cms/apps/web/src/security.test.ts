import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Rules about the code itself that are cheap to check on every run and expensive to find in review:
 * every API route goes through the gate, nothing renders raw HTML, nothing reads a client address
 * the caller can choose. A new route or page that breaks one fails here, with its name.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const API = join(SRC, 'app', 'api');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(SRC, path).replaceAll('\\', '/');
const routeFiles = walk(API).filter((f) => f.endsWith('route.ts'));
const sourceFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'));
const read = (path: string) => readFileSync(path, 'utf8');
const METHOD = /export (?:const|function|async function) (GET|POST|PUT|PATCH|DELETE)\b/g;

/** Open to the public on purpose, and why. */
const PUBLIC_ROUTES: Record<string, string> = {
  'health/route.ts': 'load balancer probe; says only up or down',
  'webleads/route.ts': 'website intake with its own Basic-auth credential (LeadXP-compatible)',
  'public/web-leads/route.ts': 'website intake with its own Basic-auth credential',
  'public/webhooks/leads/route.ts': 'website intake with its own Basic-auth credential',
  'auth/login/route.ts': 'sign in',
  'auth/forgot-password/route.ts': 'ask for a reset link',
  'auth/reset-password/route.ts': 'use a reset link',
};

describe('API routes', () => {
  it('finds the routes it is checking', () => {
    expect(routeFiles.length).toBeGreaterThan(55);
  });

  it('are all built with the request gate, except the listed public ones', () => {
    const bypass: string[] = [];
    for (const file of routeFiles) {
      const key = relative(API, file).replaceAll('\\', '/');
      if (key in PUBLIC_ROUTES) continue;
      const text = read(file);
      const methods = [...text.matchAll(METHOD)].map((m) => m[1]!);
      for (const method of methods) {
        if (!new RegExp(`export const ${method} = route\\(`).test(text)) bypass.push(`${key} ${method}`);
      }
      if (methods.length === 0) bypass.push(`${key} (no handler)`);
    }
    expect(bypass).toEqual([]);
  });

  it('only leave out the gate where the route says why (intake has its own credential)', () => {
    for (const key of Object.keys(PUBLIC_ROUTES)) {
      expect(
        routeFiles.some((f) => relative(API, f).replaceAll('\\', '/') === key),
        key,
      ).toBe(true);
    }
    for (const key of ['webleads/route.ts', 'public/web-leads/route.ts', 'public/webhooks/leads/route.ts']) {
      expect(read(join(API, key)), key).toContain('handleIntake(');
    }
  });

  it('public routes that browsers call from our pages refuse other sites', () => {
    for (const key of [
      'auth/login/route.ts',
      'auth/forgot-password/route.ts',
      'auth/reset-password/route.ts',
    ]) {
      const text = read(join(API, key));
      expect(text, key).toContain("access: 'public'");
      expect(text, key).toContain('browserOnly: true');
      expect(text, key).toMatch(/limit: \d+/);
    }
  });

  it('every sign-in, password and second-factor route sets its own, small rate limit', () => {
    const loose: string[] = [];
    for (const file of routeFiles.filter((f) => /\/(auth|account)\//.test(f.replaceAll('\\', '/')))) {
      const text = read(file);
      const key = relative(API, file).replaceAll('\\', '/');
      if (key === 'auth/sessions/route.ts' && !text.includes('export const DELETE')) continue;
      for (const m of text.matchAll(/export const (POST|DELETE|PATCH) = route\(([\s\S]*?)async/g)) {
        const limit = /limit: (\d+)/.exec(m[2]!)?.[1];
        if (!limit || Number(limit) > 20) loose.push(`${key} ${m[1]} (${limit ?? 'default'})`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('routes that change things name the policy action or roles they need', () => {
    // The routes the RBAC matrix describes are checked at the gate, before the body is read. These are the
    // ones that deliberately have no gate of their own: they act on the caller's own records or account,
    // and the service checks each record.
    const OWN_RECORDS = new Set([
      'account/password/route.ts',
      'auth/logout/route.ts',
      'auth/sessions/route.ts',
      'auth/sessions/[id]/route.ts',
      'auth/mfa/enroll/route.ts',
      'auth/mfa/confirm/route.ts',
      'auth/mfa/verify/route.ts',
      'auth/mfa/disable/route.ts',
      'auth/mfa/recovery-codes/route.ts',
      'notifications/read/route.ts',
      'leads/[id]/route.ts',
      'leads/[id]/notes/route.ts',
      'followups/route.ts',
      'followups/[id]/route.ts',
      'exports/route.ts',
      'documents/route.ts',
      'documents/[id]/route.ts',
      'documents/[id]/complete/route.ts',
      'students/[id]/documents/[docType]/route.ts',
    ]);
    const ungated: string[] = [];
    for (const file of routeFiles) {
      const key = relative(API, file).replaceAll('\\', '/');
      if (key in PUBLIC_ROUTES || OWN_RECORDS.has(key)) continue;
      const text = read(file);
      for (const m of text.matchAll(/export const (POST|PUT|PATCH|DELETE) = route\(([\s\S]*?)async/g)) {
        if (!/\b(action|roles): /.test(m[2]!)) ungated.push(`${key} ${m[1]}`);
      }
    }
    expect(ungated).toEqual([]);
  });
});

describe('the pages and shared code', () => {
  it('never render raw HTML, evaluate text as code or write into the page as markup', () => {
    const bad: string[] = [];
    for (const file of sourceFiles) {
      const text = read(file);
      if (
        /dangerouslySetInnerHTML|\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write\(/.test(text)
      )
        bad.push(rel(file));
      if (/\beval\(|new Function\(/.test(text)) bad.push(`${rel(file)} (eval)`);
    }
    expect(bad).toEqual([]);
  });

  it('read the caller’s address only through the helper that knows how many proxies to trust', () => {
    const bad = sourceFiles.filter((f) => /x-forwarded-for|x-real-ip/i.test(read(f))).map(rel);
    expect(bad).toEqual([]);
  });

  it('keep secrets out of what the browser receives (no secret in a NEXT_PUBLIC_ variable)', () => {
    const bad = sourceFiles
      .filter((f) => /NEXT_PUBLIC_[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD)/.test(read(f)))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it('do not open a way back to anywhere but our own pages', () => {
    // Every redirect target that comes from a request goes through safeNextPath.
    const raw = sourceFiles
      .filter((f) => /searchParams\.get\(['"](next|redirect|returnTo|url)['"]\)/.test(read(f)))
      .map(rel);
    expect(raw).toEqual([]);
    expect(read(join(SRC, 'app', '(public)', 'login', 'page.tsx'))).toContain('safeNextPath(');
  });

  it('keep every cookie flag in one place, httpOnly and SameSite', () => {
    const cookieSetters = sourceFiles.filter((f) => /cookies\.set\(/.test(read(f))).map(rel);
    expect(cookieSetters).toEqual(['lib/cookies.ts']);
    const text = read(join(SRC, 'lib', 'cookies.ts'));
    expect(text.match(/httpOnly: true/g)?.length).toBe(2);
    expect(text.match(/sameSite: 'lax'/g)?.length).toBe(2);
  });
});
