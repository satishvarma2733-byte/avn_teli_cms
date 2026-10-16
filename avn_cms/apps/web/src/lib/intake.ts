import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  AppError,
  intakeCredentials,
  normalizeIntake,
  parseBasicAuth,
  rateLimit,
  webLeads,
} from '@avn-cms/core';
import type { IntakeChannel } from '@avn-cms/db';
import { NextResponse, type NextRequest } from 'next/server';

import { clientIp } from './api';

/**
 * Shared handler for every unauthenticated intake route (docs/WEBLEADS_COMPATIBILITY.md §3).
 * Response bodies use the `{ success, … }` shape the existing LeadXP senders expect.
 * Logs never contain the Authorization header, phone numbers or emails.
 */
const MAX_BYTES = 32 * 1024;
const IP_LIMIT_PER_MIN = 30;

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify({ level: 'info', msg: 'intake', ...entry }));
}

export async function handleIntake(req: NextRequest, channel: IntakeChannel): Promise<Response> {
  const started = Date.now();
  const requestId = randomUUID().slice(0, 8);
  const ip = clientIp(req);

  try {
    const ipLimit = await rateLimit(`intake-ip:${ip}`, IP_LIMIT_PER_MIN, 60);
    if (!ipLimit.allowed)
      return reply(
        429,
        { success: false, error: 'RATE_LIMITED' },
        { 'Retry-After': String(ipLimit.retryAfterSeconds) },
      );

    const creds = parseBasicAuth(req.headers.get('authorization'));
    const identity = creds ? await intakeCredentials.authenticateIntake(creds.username, creds.secret) : null;
    if (!identity) {
      log({ requestId, channel, status: 401, ms: Date.now() - started });
      return reply(
        401,
        { success: false, error: 'UNAUTHENTICATED' },
        { 'WWW-Authenticate': 'Basic realm="aVn CMS web leads"' },
      );
    }

    const credLimit = await rateLimit(`intake-cred:${identity.credentialId}`, identity.rateLimitPerMin, 60);
    if (!credLimit.allowed)
      return reply(
        429,
        { success: false, error: 'RATE_LIMITED' },
        { 'Retry-After': String(credLimit.retryAfterSeconds) },
      );

    const text = await req.text();
    if (text.length > MAX_BYTES)
      return reply(422, {
        success: false,
        error: 'VALIDATION_ERROR',
        details: { body: 'The request body is too large.' },
      });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return reply(422, {
        success: false,
        error: 'VALIDATION_ERROR',
        details: { body: 'The request body is not valid JSON.' },
      });
    }

    const dto = normalizeIntake(raw);
    const idempotencyKey = req.headers.get('idempotency-key')?.trim().slice(0, 200) || null;
    const result = await webLeads.ingest({
      tenantId: identity.tenantId,
      credentialId: identity.credentialId,
      defaultSourceId: identity.defaultSourceId,
      channel,
      dto,
      rawPayload: raw,
      idempotencyKey,
    });
    log({
      requestId,
      channel,
      credentialId: identity.credentialId,
      status: 201,
      leadStatus: result.status,
      replay: result.replay,
      ms: Date.now() - started,
    });
    return reply(201, { success: true, id: result.id, status: result.status });
  } catch (err) {
    if (err instanceof AppError && err.code === 'VALIDATION_ERROR') {
      const details = (err.details as { fields?: Record<string, string> } | undefined)?.fields ?? {
        body: err.message,
      };
      log({ requestId, channel, status: 422, ms: Date.now() - started });
      return reply(422, { success: false, error: 'VALIDATION_ERROR', details });
    }
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'intake failed',
        requestId,
        channel,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return reply(500, { success: false, error: 'INTERNAL', reference: requestId });
  }
}
