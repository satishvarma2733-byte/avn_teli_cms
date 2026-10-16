import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  contextFor,
  safeEqual,
  SESSION_COOKIE,
  validateSession,
  type Ctx,
  type Principal,
} from '@avn-cms/auth';
import { getConfig } from '@avn-cms/config';
import { AppError, rateLimit } from '@avn-cms/core';
import { TenantScopeViolation } from '@avn-cms/db';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType } from 'zod';

/**
 * The request gate every API route goes through (ARCHITECTURE §3): authenticate → tenant
 * context → CSRF → rate limit → (handler: validate → authorize → service) → envelope.
 */
type Access = 'tenant' | 'principal' | 'public';

interface RouteOptions {
  access?: Access;
  /** Requests per minute per user (or per IP for public routes). Default 300 / 60. */
  limit?: number;
  /** Rate-limit bucket name (defaults to the path). */
  bucket?: string;
  /** Only for the second-factor and sign-out routes: allow a session that hasn't passed MFA yet. */
  allowPendingMfa?: boolean;
}

export interface HandlerInput {
  req: NextRequest;
  params: Record<string, string>;
  ip: string;
  userAgent: string | undefined;
}
export interface TenantInput extends HandlerInput {
  ctx: Ctx;
  principal: Principal;
}
export interface PrincipalInput extends HandlerInput {
  principal: Principal;
}

export interface Envelope {
  data: unknown;
  meta?: Record<string, unknown>;
  status?: number;
  headers?: Record<string, string>;
}
const ENVELOPE = Symbol('envelope');
type Wrapped = Envelope & { [ENVELOPE]: true };

export function ok(data: unknown, meta?: Record<string, unknown>, status = 200): Wrapped {
  return { data, ...(meta ? { meta } : {}), status, [ENVELOPE]: true };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
}

export function errorResponse(
  code: AppError['code'],
  message: string,
  details?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const err = new AppError(code, message, details);
  return NextResponse.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status: err.status, headers: { 'Cache-Control': 'no-store', ...extraHeaders } },
  );
}

/** Same-origin check for cookie-authenticated mutations (defence in depth with the CSRF token). */
function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser clients; the CSRF header is still required
  try {
    const allowed = new URL(getConfig().APP_URL).host;
    return new URL(origin).host === allowed || new URL(origin).host === req.nextUrl.host;
  } catch {
    return false;
  }
}

type RouteCtx = { params: Promise<Record<string, string | string[]>> };

export function route(
  options: RouteOptions & { access: 'public' },
  handler: (input: HandlerInput) => Promise<Wrapped | Response>,
): (req: NextRequest, rc: RouteCtx) => Promise<Response>;
export function route(
  options: RouteOptions & { access: 'principal' },
  handler: (input: PrincipalInput) => Promise<Wrapped | Response>,
): (req: NextRequest, rc: RouteCtx) => Promise<Response>;
export function route(
  options: RouteOptions,
  handler: (input: TenantInput) => Promise<Wrapped | Response>,
): (req: NextRequest, rc: RouteCtx) => Promise<Response>;
export function route(options: RouteOptions, handler: (input: never) => Promise<Wrapped | Response>) {
  const access = options.access ?? 'tenant';
  return async (req: NextRequest, rc: RouteCtx): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const raw = (await rc?.params) ?? {};
      const params = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : v]),
      );
      const ip = clientIp(req);
      const userAgent = req.headers.get('user-agent') ?? undefined;
      const base: HandlerInput = { req, params, ip, userAgent };

      let input: HandlerInput | PrincipalInput | TenantInput = base;
      let limiterKey = `ip:${ip}`;
      if (access !== 'public') {
        const principal = await validateSession(req.cookies.get(SESSION_COOKIE)?.value);
        if (!principal) return errorResponse('UNAUTHENTICATED', 'Sign in to continue.');
        if (principal.mfaEnabled && !principal.mfaVerified && !options.allowPendingMfa) {
          return errorResponse('UNAUTHENTICATED', 'Finish two-step verification to continue.', {
            mfaRequired: true,
          });
        }
        if (MUTATING.has(req.method)) {
          const token = req.headers.get('x-csrf-token') ?? '';
          if (!sameOrigin(req) || !safeEqual(token, principal.csrfToken)) {
            return errorResponse(
              'FORBIDDEN',
              'Your session token is missing or expired. Reload the page and try again.',
            );
          }
        }
        limiterKey = `user:${principal.userId}`;
        if (access === 'tenant') {
          const ctx = contextFor(principal, { ip, ...(userAgent ? { userAgent } : {}) });
          if (!ctx) return errorResponse('FORBIDDEN', 'Choose a workspace to continue.');
          input = { ...base, principal, ctx };
        } else {
          input = { ...base, principal };
        }
      }

      const limit = options.limit ?? 300;
      const rl = await rateLimit(
        `${options.bucket ?? req.nextUrl.pathname.split('/').slice(0, 4).join('/')}:${limiterKey}`,
        limit,
        60,
      );
      if (!rl.allowed) {
        return errorResponse('RATE_LIMITED', 'Too many requests. Please wait a moment.', undefined, {
          'Retry-After': String(rl.retryAfterSeconds),
        });
      }

      const result = await (handler as (i: typeof input) => Promise<Wrapped | Response>)(input);
      if (result instanceof Response) return result;
      const body: Record<string, unknown> = { data: result.data };
      if (result.meta) body['meta'] = result.meta;
      return NextResponse.json(body, {
        status: result.status ?? 200,
        headers: { 'Cache-Control': 'no-store', ...result.headers },
      });
    } catch (err) {
      return handleError(err, requestId);
    }
  };
}

export function handleError(err: unknown, requestId: string): Response {
  if (err instanceof AppError) return errorResponse(err.code, err.message, err.details);
  if (err instanceof ZodError) {
    return errorResponse('VALIDATION_ERROR', 'Some fields need attention.', { fields: fieldErrors(err) });
  }
  if (err instanceof SyntaxError)
    return errorResponse('VALIDATION_ERROR', 'The request body is not valid JSON.');
  if (err instanceof TenantScopeViolation) {
    console.error(
      JSON.stringify({ level: 'error', msg: 'tenant scope violation', requestId, error: err.message }),
    );
    return errorResponse('NOT_FOUND', 'Record not found.');
  }
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'unhandled',
      requestId,
      error: err instanceof Error ? err.stack : String(err),
    }),
  );
  return errorResponse('INTERNAL', `Something went wrong on our side. Reference: ${requestId.slice(0, 8)}`);
}

export function fieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    out[key] ??= issue.message;
  }
  return out;
}

/** Parse + validate a JSON body (max 64 KB). */
export async function jsonBody<T>(req: NextRequest, schema: ZodType<T>, maxBytes = 64 * 1024): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError('VALIDATION_ERROR', 'The request body is too large.');
  return schema.parse(text ? JSON.parse(text) : {});
}

export function query<T>(req: NextRequest, schema: ZodType<T>): T {
  return schema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
}
