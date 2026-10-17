import { login, validateSession } from '@avn-cms/auth';
import { NextRequest } from 'next/server';

import { TEST_PASSWORD } from '../../fixtures/factory';

/**
 * Calls the real API route handlers (the same functions Next.js runs) with real sessions against the
 * real database, so the whole gate — session, CSRF, rate limit, validation, policy, tenant scope — is
 * what is tested, without a browser or a server.
 */

type Handler = (req: NextRequest, rc: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Record<string, Handler | undefined>;

const modules = import.meta.glob<RouteModule>('../../../apps/web/src/app/api/**/route.ts');

/** Every API route, by its path under /api (for example `students/[id]`). */
export const ROUTES: string[] = Object.keys(modules)
  .map((key) => key.replace('../../../apps/web/src/app/api/', '').replace(/\/route\.ts$/, ''))
  .sort();

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof HTTP_METHODS)[number];

async function load(route: string): Promise<RouteModule> {
  const loader = modules[`../../../apps/web/src/app/api/${route}/route.ts`];
  if (!loader) throw new Error(`No such route: ${route}`);
  return loader();
}

/** The methods a route answers. */
export async function methodsOf(route: string): Promise<Method[]> {
  const mod = await load(route);
  return HTTP_METHODS.filter((m) => typeof mod[m] === 'function');
}

export interface Caller {
  token: string;
  csrf: string;
  userId: string;
  role: string;
}

export async function signIn(workspace: string, email: string, password = TEST_PASSWORD): Promise<Caller> {
  const res = await login({ workspace, email, password });
  if (!res.ok) throw new Error(`sign-in failed for ${email}`);
  const principal = (await validateSession(res.token))!;
  return { token: res.token, csrf: principal.csrfToken, userId: principal.userId, role: principal.role };
}

export interface CallOptions {
  /** Path parameters, for example `{ id: '…' }`. Missing ones get a harmless value. */
  params?: Record<string, string>;
  query?: Record<string, string>;
  caller?: Caller | null;
  body?: unknown;
  /** Send the body as-is (a string) instead of JSON. */
  rawBody?: string;
  /** 'valid' (default for a signed-in caller), 'none', or a literal token. */
  csrf?: 'valid' | 'none' | string;
  /** The address this caller appears to come from (needs one trusted proxy, as in tests). */
  ip?: string;
  headers?: Record<string, string>;
  /** Defaults to the app's own origin. Pass null to send none (a command-line client). */
  origin?: string | null;
}

export interface Reply {
  status: number;
  /** Parsed JSON, or the text when the body is not JSON. */
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}

const FILL: Record<string, string> = {
  id: '00000000-0000-4000-8000-000000000000',
  docType: 'PASSPORT',
  report: 'funnel',
};

let ipSeq = 0;
/** A fresh address per call site, so one test's requests never count against another's rate limit. */
export const freshIp = (): string =>
  `10.${(Date.now() >> 8) & 255}.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`;

export async function call(route: string, method: Method, options: CallOptions = {}): Promise<Reply> {
  const mod = await load(route);
  const handler = mod[method];
  if (!handler) throw new Error(`${method} ${route} does not exist`);
  const params: Record<string, string> = {};
  const path = route.replace(/\[(\w+)\]/g, (_m, name: string) => {
    params[name] = options.params?.[name] ?? FILL[name] ?? FILL['id']!;
    return params[name];
  });
  const search = options.query ? `?${new URLSearchParams(options.query)}` : '';
  const headers: Record<string, string> = {
    'x-forwarded-for': options.ip ?? freshIp(),
    ...(options.origin === null ? {} : { origin: options.origin ?? 'http://localhost:3300' }),
    ...options.headers,
  };
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  if (hasBody) headers['content-type'] ??= 'application/json';
  if (options.caller) {
    headers['cookie'] = `avn_session=${options.caller.token}`;
    const csrf = options.csrf ?? 'valid';
    if (csrf === 'valid') headers['x-csrf-token'] = options.caller.csrf;
    else if (csrf !== 'none') headers['x-csrf-token'] = csrf;
  }
  const raw = options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined);
  if (raw !== undefined) headers['content-length'] = String(Buffer.byteLength(raw));
  const req = new NextRequest(`http://localhost:3300/api/${path}${search}`, {
    method,
    headers,
    ...(raw !== undefined ? { body: raw } : {}),
  });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, headers: res.headers };
}
