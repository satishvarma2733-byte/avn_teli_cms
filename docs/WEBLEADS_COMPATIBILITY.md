# Web-Leads Compatibility (LeadXP `/api/webleads`)

> Compatibility design, not an integration. aVn CMS will accept leads in exactly the
> shape the current LeadXP web-leads API receives them. A website that posts to LeadXP
> today can later switch to aVn CMS by changing **configuration only** (URL +
> credentials), with no change to its code. Connecting eWings is a later, separate step
> (§7); nothing here touches the eWings website.

---

## 1. Why

The live product receives website enquiries at `https://leadxp.aikosoft.ai/api/webleads`.
The eWings website and blog already post there. If aVn CMS only offered its own new
intake API (`/api/public/web-leads`), every sending site would need a code change to
switch. A compatible endpoint keeps the switch to a URL and credential swap, and lets
the cutover be tested and reversed per site.

---

## 2. Existing callers (verified from the eWings source, read-only)

Two different payload shapes reach LeadXP today. aVn CMS must accept **both**.

### 2a. eWings main site — `public/api/send_email.php`

```http
POST {LEAD_API_URL}
Content-Type: application/json
Authorization: {LEAD_API_AUTH}            ← full header value, e.g. "Basic base64(user:pass)"; omitted if empty
```

```json
{
  "name": "…",              "mobile": "…",          "email": "…",
  "message": "…|null",      "parent_student": "…|null",
  "education": "…|null",    "group": "…|null",
  "neet_status": "…|null",  "neet_score": 512,      // int or null
  "preferred_country": "…|null",
  "google_click_id": "…|null", "campaign_id": "…|null",
  "source": "…"             // defaults to "Landing Page"
}
```

Sent after the notification email. cURL timeout **4 s**, connect timeout **2 s**.
Response is **ignored**; no retry.

### 2b. eWings blog — `blog/src/server/leads.service.ts`

```http
POST {LEAD_API_URL}
Content-Type: application/json
Authorization: Basic base64(WEBLEADS_API_USERNAME:WEBLEADS_API_PASSWORD)
```

```json
{
  "name": "…", "phone": "…", "email": "…|undefined",
  "city": "…|undefined", "neetScore": "…|undefined",   // string
  "source": "…",                                        // defaults to "blog_inline_cta"
  "postSlug": "…|undefined"
}
```

Sent after the lead is saved in the blog's own database. No timeout, not awaited, no
retry. Only `res.ok` is checked (logged); the body is logged as text on failure.

### 2c. Not verified

- LeadXP's own response body, status codes and validation rules: neither caller reads
  them, so any `2xx` keeps both callers working.
- Whether any site other than eWings posts to LeadXP.

---

## 3. The compatible endpoint

```
POST /api/webleads
```

Same path as LeadXP, so a cutover changes only the host in `LEAD_API_URL`. It is an
**adapter** in front of the same `webLeads` service as `/api/public/web-leads`. There is
one intake pipeline, not two.

### Authentication and tenancy

- **HTTP Basic**, checked against a tenant's **intake credential** (`intake_credentials`,
  see `DATABASE_SCHEMA.md`). `username` is public; the secret is shown once and stored
  only as a hash.
- The credential decides the tenant. There is no session on this route, and any tenant
  or owner field in the body is ignored.
- Missing or wrong credentials → `401`. A revoked credential → `401`.
- HTTPS only outside local development. No CORS: server-to-server only, so browsers
  cannot call it directly.

### Field normalisation (both shapes → one DTO)

| Incoming (2a main site) | Incoming (2b blog) | `web_leads` column | Rule |
|---|---|---|---|
| `name` | `name` | `name` | Required, trimmed, 1–200 chars |
| `mobile` | `phone` | `phone_raw` → `phone_e164` | Required. Raw value kept. Normalised to E.164 (default region IN) for dedupe |
| `email` | `email` | `email` | Optional. `""`/`null` → null. Invalid → kept in `raw_payload`, column null, flag `INVALID_EMAIL` (do not reject) |
| `message` | — | `message` | Optional, ≤ 5,000 |
| `preferred_country` | — | `interest_country` | Optional |
| `neet_score` (int) | `neetScore` (string) | `neet_score` (int) | Parse digits; non-numeric → null, original kept in `raw_payload` |
| `neet_status` | — | `neet_status` | Optional text |
| `education` | — | `education` | Optional text |
| `group` | — | `education_group` | Optional text (e.g. BiPC) |
| `parent_student` | — | `submitted_by` | Optional text (parent / student) |
| — | `city` | `city` | Optional |
| — | `postSlug` | `post_slug` | Optional |
| `google_click_id` | — | `gclid` | Optional; kept for ads attribution |
| `campaign_id` | — | `campaign_id` | Optional |
| `source` | `source` | `source_label` + `source_id` | Original string kept in `source_label`. `source_id` resolved through the tenant's source mapping (e.g. `Landing Page` → `WEBSITE`); unmapped → `WEBSITE` |
| *(any other field)* | *(any other field)* | `raw_payload` | Whole request body always stored as received |

Also set: `intake_channel = 'LEADXP_COMPAT'`, `intake_credential_id`,
`submitted_at = now()`. Optional extended attribution (`page_url`, `landing_page`,
`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `form_id`,
`session_id`), in camelCase or snake_case, is accepted when a sender adds it later. No
sender has to.

**Validation is deliberately lenient.** The endpoint rejects only what the current
callers never send: missing name, missing or unparseable phone, a body that is not a
JSON object, or a body over 32 KB. Everything else is stored and flagged, so a
compatible sender is never silently refused.

### Responses

| Case | Status | Body |
|---|---|---|
| Stored (new or duplicate) | `201` | `{ "success": true, "id": "<web_lead uuid>", "status": "NEW" \| "DUPLICATE" }` |
| Bad credentials | `401` | `{ "success": false, "error": "UNAUTHENTICATED" }` |
| Missing name / phone, bad JSON | `422` | `{ "success": false, "error": "VALIDATION_ERROR", "details": { … } }` |
| Too many requests | `429` | `{ "success": false, "error": "RATE_LIMITED" }` + `Retry-After` |
| Server error | `500` | `{ "success": false, "error": "INTERNAL" }` (no internals) |

The `success` / `error` shape follows the eWings endpoints' own style. Callers ignore it
today, so it can be changed safely before cutover.

### Speed

The main-site caller gives up after 4 s, so the request path does only: authenticate →
normalise → one indexed duplicate lookup on `(tenant_id, phone_e164)` → insert → enqueue
`web_lead.created` → respond. Target **p95 < 500 ms**. Assignment, round-robin,
automations and notifications run in the worker.

### Duplicates and retries

- Neither caller retries or sends an idempotency key. A repeat submission is a new
  `web_leads` row, marked `DUPLICATE` with `dedupe_match_student_id` when the phone
  matches a student or an earlier web lead. A person is never created twice
  (`ARCHITECTURE.md` §6).
- An `Idempotency-Key` header is honoured if a sender adds one later (same key + same
  credential within 24 h → the first response is returned, no new row).

### Limits

Per credential: 120 requests a minute. Per IP: 30 a minute. Both are tenant settings.
Over the limit → `429`.

---

## 4. Managing intake credentials (Tenant Admin)

Settings → Integrations → **Web-lead credentials**: create (name, optional allowed
source label), the secret is shown once with the ready-made `Authorization` header and
the endpoint URL; rotate (old secret valid for an overlap window, default 24 h); revoke;
"last used" timestamp and count. Every create, rotate and revoke is audited. See
`RBAC_MATRIX.md` and `PAGES_AND_ROUTES.md`.

---

## 5. Security notes

- Secrets hashed (SHA-256 of a 256-bit random secret, constant-time compare). They are
  never logged and never returned after creation.
- Request logs record credential id, tenant, status and duration. They never record the
  `Authorization` header, phone or email.
- `raw_payload` is tenant-scoped like every other column (RLS applies).
- Spam: the eWings callers already filter honeypot hits before posting. aVn CMS adds its
  own intake checks (`DEVELOPMENT_PHASES.md` Phase 5) without rejecting valid leads.

---

## 5a. As built (2026-10-16)

Implemented exactly as specified above, in `avn_cms/`:

| Piece | Location |
|---|---|
| Endpoint `POST /api/webleads` (+ `/api/public/web-leads`, `/api/public/webhooks/leads`, same pipeline) | `apps/web/src/app/api/webleads/route.ts`, `apps/web/src/lib/intake.ts` |
| Normaliser (both eWings shapes + camel/snake attribution) | `packages/core/src/webLeads/intake.ts` |
| Basic-auth credential lookup, rotation (24 h overlap), revoke | `packages/core/src/webLeads/credentials.ts` |
| Ingest, dedupe (student phone + 24 h repeat), idempotency, inbox, convert | `packages/core/src/webLeads/webLead.service.ts` |
| Settings → Website integrations (create / rotate / revoke, secret shown once) | `apps/web/src/app/(app)/app/settings/integrations/` |

Verified: 12 contract tests (`tests/integration/webleads.int.test.ts`, every §6 item, p95 well
under 500 ms), HTTP smoke `pnpm smoke:webleads` 7/7 against the running app, and the e2e flow
credential → POST → inbox → convert. **No eWings file was changed**; the fixtures are copies
of the eWings payloads (`tests/fixtures/ewings-payloads.ts`).

## 6. Contract tests (Phase 5 exit criteria)

Fixtures are the two payloads in §2, copied field-for-field from the eWings source.

- Main-site shape → `201`, every mapped column filled, `raw_payload` equals the body.
- Blog shape → `201`; `neetScore: "512"` stored as `512`; `email: undefined` → null.
- `Authorization` built exactly as `postbuild.mjs` builds `LEAD_API_AUTH` → accepted.
- Wrong secret, revoked credential, no header → `401`, nothing stored.
- Missing phone or name → `422`, nothing stored.
- Unknown extra fields → stored in `raw_payload`, no error.
- Same phone twice → second row `DUPLICATE`, one student.
- Tenant A's credential never writes into tenant B (isolation suite).
- p95 under 500 ms with the worker stopped (nothing heavy in the request path).
- A 4 s client timeout never fires in the e2e run.

---

## 7. Later: switching a site (not part of the current build)

Owner actions on the sending site's **configuration**, when the integration is approved:

1. In aVn CMS, create a web-lead credential for the tenant.
2. eWings blog env: `LEAD_API_URL=https://<avn-cms-host>/api/webleads`,
   `WEBLEADS_API_USERNAME`, `WEBLEADS_API_PASSWORD`.
3. eWings main site env: `LEAD_API_URL` as above, and
   `LEAD_API_AUTH=Basic <base64(user:pass)>`. The generated `config.php` reads
   `getenv()` first, so a server env change works without a rebuild. A rebuild also
   bakes the new values in.
4. Submit one test enquiry from each form and confirm it in the aVn CMS Web Leads inbox.

**Rollback:** restore the previous `LEAD_API_URL` and credentials. Leads received in
the meantime stay in aVn CMS and can be exported.

**Not possible by configuration alone:** sending each lead to both LeadXP and aVn CMS.
Each caller has one URL. If a parallel run is wanted, aVn CMS would forward a copy to
LeadXP from its worker (a later option, needs LeadXP credentials). The website stays
unchanged.
