import { intakeCredentials, webLeads } from '@avn-cms/core';
import { ownerDb } from '@avn-cms/db/owner';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it } from 'vitest';

import { POST as webleadsPOST } from '@/app/api/webleads/route';

import { ctxFor } from '../fixtures/ctx';
import { basicAuth, EWINGS_BLOG, EWINGS_MAIN_SITE } from '../fixtures/ewings-payloads';
import { makeLead, makeTenant, makeUser, resetData } from '../fixtures/factory';

/** Contract tests: docs/WEBLEADS_COMPATIBILITY.md §6. Real route handler, real database. */
function post(body: unknown, auth: string | null, headers: Record<string, string> = {}) {
  return webleadsPOST(
    new NextRequest('http://localhost:3300/api/webleads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: auth } : {}),
        'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}`,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('POST /api/webleads (LeadXP-compatible)', () => {
  let tenant: { id: string };
  let admin: Awaited<ReturnType<typeof makeUser>>;
  let auth: string;
  let credId: string;
  let username: string;

  beforeEach(async () => {
    await resetData();
    tenant = await makeTenant('ewings-test');
    admin = await makeUser(tenant.id, 'TENANT_ADMIN');
    const cred = await intakeCredentials.createCredential(ctxFor(admin), { name: 'eWings website (test)' });
    auth = cred.authorization;
    credId = cred.id;
    username = cred.username;
    // The header we return is exactly what eWings' postbuild.mjs builds from user + pass.
    expect(auth).toBe(basicAuth(cred.username, cred.secret));
  });

  it('accepts the eWings main-site payload unchanged and maps every column', async () => {
    const res = await post(EWINGS_MAIN_SITE, auth);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; id: string; status: string };
    expect(body).toMatchObject({ success: true, status: 'NEW' });
    const row = await ownerDb().webLead.findUniqueOrThrow({
      where: { id: body.id },
      include: { source: true },
    });
    expect(row).toMatchObject({
      tenantId: tenant.id,
      name: 'Test Student',
      phoneRaw: '9876543210',
      phoneE164: '+919876543210',
      email: 'student@example.test',
      message: 'Need details for MBBS abroad',
      interestCountry: 'Kyrgyzstan',
      neetScore: 512,
      neetStatus: 'Qualified',
      education: 'Intermediate',
      educationGroup: 'BiPC',
      submittedBy: 'Parent',
      gclid: 'Cj0KCQ-test',
      campaignId: '123456789',
      sourceLabel: 'Landing Page',
      intakeChannel: 'LEADXP_COMPAT',
      intakeCredentialId: credId,
    });
    expect(row.source?.code).toBe('GOOGLE_ADS'); // a Google click id means paid search
    expect(row.rawPayload).toEqual(EWINGS_MAIN_SITE);
  });

  it('accepts the eWings blog payload (string score, no email)', async () => {
    const res = await post(EWINGS_BLOG, auth);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await ownerDb().webLead.findUniqueOrThrow({ where: { id }, include: { source: true } });
    expect(row).toMatchObject({
      neetScore: 498,
      email: null,
      city: 'Guntur',
      postSlug: 'mbbs-in-georgia-fees',
      sourceLabel: 'blog_inline_cta',
    });
    expect(row.source?.code).toBe('WEBSITE');
  });

  it('401 for wrong secret, unknown user, missing header and revoked credential — nothing stored', async () => {
    expect((await post(EWINGS_MAIN_SITE, basicAuth(username, 'wrong-secret-wrong-secret'))).status).toBe(401);
    expect((await post(EWINGS_MAIN_SITE, basicAuth('wl_doesnotexist', 'x'.repeat(40)))).status).toBe(401);
    expect((await post(EWINGS_MAIN_SITE, null)).status).toBe(401);
    await intakeCredentials.revokeCredential(ctxFor(admin), credId);
    const revoked = await post(EWINGS_MAIN_SITE, auth);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ success: false, error: 'UNAUTHENTICATED' });
    expect(await ownerDb().webLead.count()).toBe(0);
  });

  it('422 only for missing name/phone or a non-JSON body — nothing stored', async () => {
    const r1 = await post({ ...EWINGS_MAIN_SITE, mobile: undefined }, auth);
    expect(r1.status).toBe(422);
    expect(await r1.json()).toMatchObject({
      success: false,
      error: 'VALIDATION_ERROR',
      details: { phone: expect.any(String) },
    });
    expect((await post({ ...EWINGS_MAIN_SITE, name: '' }, auth)).status).toBe(422);
    expect((await post('not json', auth)).status).toBe(422);
    expect(await ownerDb().webLead.count()).toBe(0);
  });

  it('keeps unknown fields in raw_payload without error', async () => {
    const res = await post({ ...EWINGS_BLOG, extra_field: 'kept', utm_campaign: 'neet-2026' }, auth);
    const { id } = (await res.json()) as { id: string };
    const row = await ownerDb().webLead.findUniqueOrThrow({ where: { id } });
    expect((row.rawPayload as Record<string, unknown>)['extra_field']).toBe('kept');
    expect(row.utmCampaign).toBe('neet-2026');
  });

  it('flags a repeat phone as DUPLICATE, and a known student with the match', async () => {
    const first = (await (await post(EWINGS_MAIN_SITE, auth)).json()) as { status: string };
    const second = (await (await post(EWINGS_MAIN_SITE, auth)).json()) as { id: string; status: string };
    expect(first.status).toBe('NEW');
    expect(second.status).toBe('DUPLICATE');
    expect((await ownerDb().webLead.findUniqueOrThrow({ where: { id: second.id } })).qualityFlags).toContain(
      'REPEAT_SUBMISSION',
    );

    const known = await makeLead(tenant.id, { name: 'Known' });
    const third = (await (await post({ ...EWINGS_BLOG, phone: known.student.phoneE164 }, auth)).json()) as {
      id: string;
      status: string;
    };
    expect(third.status).toBe('DUPLICATE');
    expect(
      (await ownerDb().webLead.findUniqueOrThrow({ where: { id: third.id } })).dedupeMatchStudentId,
    ).toBe(known.student.id);
  });

  it('honours an Idempotency-Key (same response, no second row)', async () => {
    const a = (await (await post(EWINGS_MAIN_SITE, auth, { 'Idempotency-Key': 'form-123' })).json()) as {
      id: string;
    };
    const b = (await (await post(EWINGS_MAIN_SITE, auth, { 'Idempotency-Key': 'form-123' })).json()) as {
      id: string;
    };
    expect(b.id).toBe(a.id);
    expect(await ownerDb().webLead.count()).toBe(1);
  });

  it('a credential only ever writes into its own tenant', async () => {
    const other = await makeTenant('other-agency');
    const otherAdmin = await makeUser(other.id, 'TENANT_ADMIN');
    const otherCred = await intakeCredentials.createCredential(ctxFor(otherAdmin), { name: 'other site' });
    const { id } = (await (await post(EWINGS_MAIN_SITE, otherCred.authorization)).json()) as { id: string };
    expect((await ownerDb().webLead.findUniqueOrThrow({ where: { id } })).tenantId).toBe(other.id);
    expect(await ownerDb().webLead.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('rotation: the old secret keeps working during the overlap, the new one works at once', async () => {
    const rotated = await intakeCredentials.rotateCredential(ctxFor(admin), credId);
    expect((await post(EWINGS_BLOG, rotated.authorization)).status).toBe(201);
    expect((await post({ ...EWINGS_BLOG, phone: '9123456789' }, auth)).status).toBe(201);
    await ownerDb().intakeCredential.update({
      where: { id: credId },
      data: { previousValidUntil: new Date(Date.now() - 1000) },
    });
    expect((await post({ ...EWINGS_BLOG, phone: '9123456788' }, auth)).status).toBe(401);
  });

  it('answers well inside the main site’s 4 s cURL timeout (p95 < 500 ms)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const res = await post({ ...EWINGS_MAIN_SITE, mobile: `98765${String(10000 + i)}` }, auth);
      times.push(performance.now() - t);
      expect(res.status).toBe(201);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95) - 1]).toBeLessThan(500);
  });

  it('inbox convert: new student + lead + round-robin; duplicate attaches to the existing student', async () => {
    const counselor = await makeUser(tenant.id, 'COUNSELOR');
    await ownerDb().tenant.update({ where: { id: tenant.id }, data: { settings: { roundRobin: true } } });
    const { id } = (await (await post(EWINGS_MAIN_SITE, auth)).json()) as { id: string };
    const res = await webLeads.convert(ctxFor(admin), id, {});
    expect(res).toMatchObject({ createdLead: true, attachedToExisting: false });
    const assignment = await ownerDb().leadAssignment.findFirstOrThrow({
      where: { leadId: res.leadId, isActive: true },
    });
    expect(assignment.assigneeId).toBe(counselor.id);
    expect((await ownerDb().note.findFirstOrThrow({ where: { leadId: res.leadId } })).body).toContain(
      'Need details for MBBS abroad',
    );
    await expect(webLeads.convert(ctxFor(admin), id, {})).rejects.toMatchObject({ code: 'CONFLICT' });

    // Same person enquires again: no second student; the open lead gets a timeline entry.
    const again = (await (await post({ ...EWINGS_MAIN_SITE, message: 'Second enquiry' }, auth)).json()) as {
      id: string;
      status: string;
    };
    expect(again.status).toBe('DUPLICATE');
    const res2 = await webLeads.convert(ctxFor(admin), again.id, {});
    expect(res2).toMatchObject({
      createdLead: false,
      attachedToExisting: true,
      leadId: res.leadId,
      studentId: res.studentId,
    });
    expect(await ownerDb().student.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it('counselors cannot see the inbox (no routing yet) or convert for someone else', async () => {
    const counselor = await makeUser(tenant.id, 'COUNSELOR');
    const other = await makeUser(tenant.id, 'COUNSELOR');
    await post(EWINGS_MAIN_SITE, auth);
    expect((await webLeads.listInbox(ctxFor(counselor), { limit: 50 })).items).toEqual([]);
    const { id } = (await (await post(EWINGS_BLOG, auth)).json()) as { id: string };
    await expect(webLeads.convert(ctxFor(counselor), id, { counselorId: other.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
