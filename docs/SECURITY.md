# Security — aVn CMS

> Final for Phase 9 (2026-10-17). Written for the code in `avn_cms/`. Everything here was verified
> locally; nothing has run on a staging or production host yet (see §9 for what that leaves open).
> To report a problem, see [`../SECURITY.md`](../SECURITY.md).

## 1. What is protected, and from whom

| Asset | Worst case | Main defences |
|---|---|---|
| One agency's students, leads, documents | Another agency (or a staff member without rights) reads or changes them | Tenant from the session only; scoped database client **and** row-level security; policy gate on every route; ownership checks (`own`) in the services |
| Staff accounts | Someone signs in as a person | Argon2id, lock-out, uniform failures, two-step verification with recovery codes, session controls |
| The platform (super admin) | Every agency is exposed at once | Shorter sessions, optional required two-step verification, audited impersonation |
| Uploaded documents | Malware served to staff; files read by outsiders | Private bucket, signed URLs, type allow-list, virus scan before release (fails closed) |
| Website intake | Spam, forged submissions, credential theft | Per-site credentials (hashed, rotatable), per-address and per-credential limits |

Attackers considered: someone on the internet with no account; a signed-in user of one agency trying to reach
another's data or higher rights; a website or page on another origin tricking a signed-in browser; someone with a
stolen session cookie or a leaked password.

## 2. Controls

### 2.1 Signing in and sessions

- **Passwords:** Argon2id (19 MiB, 2 passes). At least 12 characters, letters mixed with numbers or symbols, and not
  one of the first guesses (`password`, `qwerty`, the product name, repeated patterns…, however dressed up with
  digits). Reset links are single-use, expire in 1 hour (invites 72 hours) and are stored only as a hash; resetting a
  password signs the person out everywhere.
- **One answer for every failure:** an unknown workspace, an unknown email, a wrong password, a disabled account and an
  account paused after too many tries all give the same message, status and headers, and take the same time (a dummy
  hash is checked). A paused account never says so. Only a *suspended workspace* is named, because that is a fact about
  the workspace.
- **Lock-out:** five wrong passwords pause the account, doubling each time up to an hour. Resetting the password lifts
  it. (An attacker who knows an email can keep that one account paused; the alternative is letting them guess. The
  per-address limit below bounds how fast they can do either.)
- **Sessions:** a random 256-bit token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` on HTTPS), stored only as a
  SHA-256 hash. A new token at every sign-in. Workspace sessions end after `SESSION_TTL_HOURS` (default 7 days) or 48
  hours without a request; **platform sessions after 12 hours and 4 hours idle**. At most 20 signed-in devices per
  person (the oldest is signed out). People see their sessions, sign one or all others out, and a password change or
  turning two-step verification on or off signs the others out. A disabled person, a changed role or a suspended
  workspace stops working at the next request. Ended sessions and used reset links are deleted after 30 / 7 days
  (`auth-cleanup`, hourly).
- **Two-step verification (TOTP, RFC 6238):** optional per person; **required for chosen roles** with
  `MFA_REQUIRED_ROLES` (such a role can do nothing but set it up and sign out until it has, and cannot turn it off).
  - *Turning it on* needs the account password (a stolen session alone cannot add a factor the owner does not have).
  - *A code works once:* the newest accepted 30-second step is remembered, so a code seen over a shoulder is useless.
  - *Wrong codes pause the checks:* five in a row stop second-factor checks for 5 minutes, doubling each time to an hour,
    even for the right code. Every second-factor entry point (sign-in, turning off, new recovery codes) shares this.
  - *Recovery codes:* ten one-time codes (about 50 bits each) shown once, stored only as keyed HMACs (a copy of the
    database cannot be used to guess them), usable for sign-in and for turning it off, replaced as a set on request.
  - The secret is encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`).

### 2.2 The request gate (`apps/web/src/lib/api.ts`)

Every API route is built with `route()`; a test fails if one is not (the eight routes open without a session are listed
by name with the reason: health, the metrics scrape — token only, 404 until `METRICS_TOKEN` is set — the three intake
endpoints, sign-in, forgot and reset password). In order, a request passes:

1. **Session** (or not, for the public routes). No session: 401, counted per address (120 a minute), so guessing
   tokens or flooding costs nothing but a lookup.
2. **Second factor:** a session that has not passed it, or a role that must set it up, reaches only sign-out and the
   second-factor routes.
3. **Roles / policy action:** the route declares the RBAC action (`action: 'user:manage'`) or the roles it is for; a
   role the matrix refuses gets **403 before the body is read**, so it learns nothing about the route's input.
4. **CSRF** on every state-changing request: a per-session token in `X-CSRF-Token` (compared in constant time) *and*
   a same-origin check (`Origin` and `Sec-Fetch-Site`), *and* only JSON or an upload form is accepted as a body (a
   cross-site `<form>` can only send text). Public routes that browsers call from our pages (sign-in, reset) refuse
   other sites too.
5. **Rate limit** per user per route (default 300 a minute; sign-in 10, reset 5–10, second factor 10) in Redis
   (atomic count + expiry). Without Redis each instance keeps its own floor.
6. **Handler:** the body is validated with Zod (64 KB cap, unknown fields dropped, so nothing is mass-assigned), then the
   service checks the policy again with the record (404 for records you may not see).
7. **Answer:** `{ data }` or `{ error: { code, message } }`. Internal errors give a reference id and nothing else; no stack,
   query or path is ever sent (tested on every route). Every answer also carries `X-Request-Id`, the id in the logs.

Rate-limit counters are kept apart for reads and writes of one path, so a person browsing a list cannot use up the limit
that protects the write on the same path (found by the load test).

**Client address.** Rate limits, the audit log and the session list use the caller's address. `X-Forwarded-For` is a
list the *caller* can start, so only the entry added by our own proxy counts: `TRUSTED_PROXY_HOPS` (default 0 = ignore
the header; 1 = one load balancer or CDN in front) picks it from the **right**. A caller cannot dodge a limit by
inventing addresses (tested).

### 2.3 Workspace isolation

- The tenant comes from the session, never the request. The application's database role (`avn_app`) has **row-level
  security** on every tenant table and a scoped client that adds the tenant to every query; either alone would hold.
- The application role **cannot read password hashes, MFA secrets or lock counters** (column privileges on `users`),
  cannot read sessions, reset tokens or recovery codes at all, and cannot change or delete audit, activity and
  stage-history rows. Credentials are handled only by `packages/auth` with the owner role (ESLint stops anything else
  importing it).
- Records belong to a workspace and, for counselors and telecallers, to a person (`own`): the answer for anything else
  is 404, not 403, so ids reveal nothing.
- **One deliberate exception to "everything goes through row-level security":** `search_student_ids` (Phase 10). Under
  row-level security Postgres cannot use a trigram index for `LIKE`, so student search runs in a `SECURITY DEFINER`
  function owned by the table owner. It is safe because it repeats the policy itself — `tenant_id = app_tenant_id()` and
  `deleted_at IS NULL`, nothing returned when no workspace is set — takes the search text only as a bound value (the one
  piece of SQL it builds is a fixed choice between conditions), has a fixed `search_path`, returns ids only, and is
  executable by `avn_app` alone. It trusts the same thing the policies trust: the workspace the tenant-scoped client set for
  the transaction. `tests/integration/lead-search.int.test.ts` checks that it returns only the workspace asked for, nothing
  when none is set, that nobody else can run it, and that a search made of SQL is plain text. Any further `SECURITY
  DEFINER` function needs the same treatment and an entry here.

### 2.4 Input and output

- **SQL:** Prisma with bound parameters; the few raw queries are tagged templates (no `*Unsafe` in application code).
  Search text, cursors and filters are validated; hostile input is tested on the list routes.
- **HTML/XSS:** React escapes everything; there is no `dangerouslySetInnerHTML`, `innerHTML` or `eval` anywhere (a test
  scans for it). Hostile names, messages, notifications and rule names are rendered as text in the browser tests.
- **Spreadsheets:** cells starting `= + - @` are neutralised in CSV and Excel exports and in import error reports.
- **Redirects:** `?next=` is accepted only for a page inside `/app` or `/platform`, never `//host`, `/\host`, a scheme or
  control characters.
- **Headers (pages):** a strict CSP with a **per-request nonce** for scripts and style elements (`style-src` has no
  `unsafe-inline`; only style *attributes* may be inline), `frame-ancestors/frame-src/object-src/worker-src/media-src
  'none'`, `base-uri`/`form-action` `'self'`, `connect-src` own origin plus the document store; `upgrade-insecure-requests`
  and **HSTS** when `APP_URL` is HTTPS; `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy` and `-Resource-Policy: same-origin`. **API answers** carry `default-src 'none'` and
  `Cache-Control: no-store`. No `X-Powered-By`.
- **Files:** `Content-Disposition: attachment` with a sanitised name and `nosniff` on every download.

### 2.5 Files, links and keys

- **Documents:** private bucket reached only through signed URLs bound to the file type and size, a type allow-list with
  a first-bytes check, a ClamAV scan before release (unavailable scanner = file stays unavailable), 5-minute download
  links, every download audited (`DOCUMENTS.md`).
- **Exports/imports:** download links are signed (HMAC), expire in 15 minutes and are usable only by the person they
  were made for, in their workspace. Exports are role-limited; telecallers get no contact columns.
- **Intake credentials:** random 256-bit secrets stored as hashes, shown once, rotated with a 24-hour overlap, revocable,
  limited per address and per credential.
- **Secrets:** read once by `packages/config`, never logged, never in `NEXT_PUBLIC_*`; the repository and its history
  were scanned (no secret, and `.env` was never committed).
- **Logs and metrics (Phase 10):** the access log records method, path (never the query string, which carries search
  text and phone numbers), status, time and the ids of the person and workspace; never headers, cookies or bodies.
  Render errors are logged without request headers. `/api/metrics` exists only when `METRICS_TOKEN` is set, wants it as a
  bearer token (compared in constant time, rate limited per address) and holds counts and timings only — no names, ids or
  personal data. Treat the token like any secret and scrape from inside the private network where possible.

### 2.6 Dependencies and pipeline

CI (`.github/workflows`) runs lint, types, formatting, unit, integration and browser tests, and on every push, pull
request and weekly: **`pnpm audit` (fails on moderate or worse), a secret scan of the code and all of its history
(gitleaks), and CodeQL** (`security-extended`). Dependabot proposes updates weekly. This phase upgraded `nodemailer`
7→10 and `csv-parse` 6→7 and pinned patched releases of three transitive packages: **18 advisories (6 high) → 0**.

## 3. Internal penetration-test checklist

Each category is a test that runs in `pnpm test` (the file is named); a finding is listed in §4.

| Category | What is checked | Where |
|---|---|---|
| **Authentication** | uniform failures; paused account indistinguishable; lock-out; per-address limit; forged forwarding addresses; cross-site sign-in; new session per sign-in | `security-http.int.test.ts`, `auth.int.test.ts` |
| **Session management** | revoked, expired, idle, disabled-user, suspended-workspace sessions; junk and oversized cookies; platform lifetime; device cap; clean-up | `security-http`, `mfa.int.test.ts` |
| **MFA** | password to enrol; replay; pause after wrong codes; recovery codes (once, any spacing, hashed, regenerate, disable); required roles; sign-out of other devices | `mfa.int.test.ts`, `security-http`, `security.spec.ts` |
| **CSRF / cross-site** | **every** state-changing route refuses: no token, wrong token, someone else's token, foreign `Origin`, `Sec-Fetch-Site: cross-site`, text/plain body | `security-http` (all routes, generated from the file system) |
| **Authentication required** | **every** non-public route answers 401 with no session | `security-http` |
| **RBAC** | every route against the policy matrix for admin, counselor, telecaller; platform routes for platform staff only; every matrix action is placed | `security-tenant.int.test.ts`, `policy.test.ts` |
| **IDOR / BOLA** | 35 operations on another workspace's records answer 404 and change nothing (snapshot of everything B owns before and after); same-workspace: counselor vs a colleague's lead, call, student, documents; notifications, sessions and exports belong to one person | `security-tenant` |
| **Tenant leak** | lists, searches, filters, reports show only the caller's workspace; ids, sources and people from another workspace cannot be used as references or filters | `security-tenant`, `tenancy.int.test.ts` |
| **Injection** | SQL meta-characters, `%`, wrong types and operators-as-objects in search, filters, cursors, ids and bodies: 4xx, never 5xx, nothing leaked, tables intact | `security-tenant` |
| **XSS** | markup in a student name, web lead, notification, rule name and run log is shown as text; no script runs, no element appears | `security.spec.ts` |
| **Mass assignment** | extra fields (`tenantId`, `createdById`, `role: SUPER_ADMIN`, `starterKey`, `deletedAt`) are ignored or refused | `security-http` |
| **Upload** | type allow-list, first-bytes check, signed type and size, infected file never downloadable, counselor scope | `documents.int.test.ts`, `documents.spec.ts` |
| **Export / import** | formula injection neutralised; role-limited columns; signed per-user links; expiry | `exports.int.test.ts`, `imports.int.test.ts` |
| **Information leak** | no stack, query, file path or library name in any answer, on every route, with hostile ids | `security-http` |
| **Rate limiting** | sign-in, anonymous flood, per route; forged addresses; no proxy | `security-http` |
| **Headers / CSP** | the real headers on pages and API; the nonce matches the scripts; no violation on 16 pages and a dialog; HSTS only on HTTPS | `security.spec.ts`, `proxy.test.ts` |
| **Open redirect** | `/\host` and 14 other forms refused; a good `next` honoured | `request.test.ts`, `security.spec.ts` |
| **Code rules** | no route outside the gate; no raw HTML/eval; no direct forwarding-header reads; cookie flags in one place; secrets never in `NEXT_PUBLIC_*` | `apps/web/src/security.test.ts` |
| **Dependencies / secrets** | `pnpm audit`, gitleaks (history), CodeQL | CI `security.yml` (audit run locally: 0) |

## 4. Findings

Priority: **P1** could lead to taking over an account or another agency's data with realistic effort; **P2** a real
weakness with limited reach; **P3** hardening. **No P0 or P1 was found in the application code.** Everything below was
found by this review and is fixed and covered by a test.

| # | Pri | Finding | Fix |
|---|---|---|---|
| 1 | P2 | The client address was the *first* `X-Forwarded-For` entry, which the caller writes: per-address limits (including sign-in) could be dodged and the audit log's address forged | Only entries added by our own proxy count (`TRUSTED_PROXY_HOPS`) |
| 2 | P2 | Second-factor codes could be tried without limit (about 10 a minute) and a code could be reused | Replay protection, pause after five wrong codes, shared by every second-factor entry |
| 3 | P2 | A stolen session could turn on two-step verification for an account (locking the owner out) because no password was asked | Enrolment needs the password; other devices are signed out when it is turned on or off |
| 4 | P2 | A person who lost their phone had no way back in | One-time recovery codes |
| 5 | P2 | An account paused for too many wrong passwords answered differently from an unknown account (account enumeration) | One answer for every failure |
| 6 | P2 | Open redirect after sign-in: `?next=/\evil.example` passed the check and browsers read it as `//evil.example` | `safeNextPath` (own pages only) |
| 7 | P2 | Routes read and validated the body *before* the role check, so a role without access got validation messages (an information leak; on a few routes a lookup error even came before the role check) | Policy gate at the route wrapper, before the body; the matrix test now checks every route |
| 8 | P2 | The application database role could read password hashes, MFA secrets and lock counters of its own workspace | Column privileges: it can read and change only non-credential columns |
| 9 | P2 | 18 dependency advisories (6 high), mostly `nodemailer` and `csv-parse` | Upgrades, pinned patches, CI audit |
| 10 | P3 | Cancelling an import that does not exist answered 409 instead of 404 | 404 |
| 11 | P3 | Rate-limit counter and expiry were two Redis calls (a crash between them left a counter that never expired); unsigned requests were not counted at all | One atomic call; unsigned requests counted per address |
| 12 | P3 | Platform (super-admin) sessions lasted as long as everyone's, a person could have unlimited sessions, ended sessions were never deleted | 12 h / 4 h idle, 20 devices, hourly clean-up |
| 13 | P3 | A password such as `Password-2026!` met the length and mix rules | Common-password check |
| 14 | P3 | No HSTS, no `Cross-Origin-Resource-Policy`, `style-src 'unsafe-inline'`, JSON bodies not required, API answers had no policy | Added; the one library that adds a style at run time (Radix scroll lock) is given the nonce; Zod's `eval` probe is switched off in the browser |
| 15 | P3 | No CI: no automatic dependency, secret or static-analysis scan | `.github/workflows`, Dependabot, gitleaks config |

## 5. Settings that matter (see `DEPLOYMENT.md` §2)

| Setting | Why |
|---|---|
| `TRUSTED_PROXY_HOPS` | **Set it to the number of proxies in front of the app** (1 for one load balancer or CDN). Left at 0 behind a proxy, every caller shares one address and the limits become site-wide; set too high, a caller can pick their address |
| `MFA_REQUIRED_ROLES` | Recommended in production: `SUPER_ADMIN,TENANT_ADMIN` |
| `APP_URL` | Must be the public `https://` origin: turns on `Secure` cookies, HSTS and `upgrade-insecure-requests` |
| `SESSION_TTL_HOURS` | Lower it (24–72) if staff share machines |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | 32+ random bytes each, stored in the host's secret store; back up the key separately; changing it invalidates every authenticator and recovery code |
| `METRICS_TOKEN` | Leave unset unless something scrapes `/api/metrics`; then 24+ random characters in the host's secret store, and scrape from the private network |
| `ACCESS_LOG` | `errors` (default) logs failures and slow requests; `all` is for investigations (it is one line per request) |

## 6. Responding to an incident

- **A password is exposed:** reset it (Users → Reset password signs the person out everywhere), check their sessions.
- **A session cookie is exposed:** the person (or an admin resetting their password) signs out other devices; revoking
  all sessions of a user is `revokeAllSessions`.
- **An intake credential is exposed:** Settings → Website integrations → revoke, or rotate (24-hour overlap).
- **`ENCRYPTION_KEY` or `SESSION_SECRET` is exposed:** replace it; everyone signs in again, and everyone with two-step
  verification re-enrols (recovery codes are keyed with the same key).
- **A workspace is compromised:** suspend it from the platform screen (all its sessions stop at the next request);
  the audit log keeps every sign-in, failure, lock, privilege and credential change with address and device.
- **Evidence:** audit entries `auth.*`, `user.*`, `intake_credential.*`, `automation.*`, `document.*`.

## 7. Verifying this document

```bash
pnpm lint && pnpm typecheck && pnpm test        # includes every row of §3 except the CI-only ones
pnpm test:e2e                                    # headers, CSP, XSS, sign-in redirects, two-step verification
pnpm audit --audit-level moderate               # advisories (also weekly in CI)
```

## 8. Not done, and why

- **Cloudflare R2 is untested** (no account yet): the signed-URL, CORS and scan flows follow the vendor documents and are
  verified on MinIO + ClamAV (`DOCUMENTS.md` §9).
- **No third-party penetration test or DAST run.** This was an internal review with tests. Run an independent test
  (and OWASP ZAP against staging) before go-live.
- **Nothing has run behind a real proxy or TLS terminator.** `TRUSTED_PROXY_HOPS`, HSTS and `Secure` cookies are tested
  as functions and headers, not on a host.
- **Phishing-resistant sign-in (passkeys/WebAuthn)** is not offered; TOTP can be phished.
- **No sign-in alert emails** and no "new device" notice.
- **Rate limits fail open when Redis is down** (each instance keeps an in-memory floor). Alert on the health check.
- **The pause after wrong passwords can be used to keep one known account paused** (§2.1). Password reset lifts it.
- **Document downloads are audited when the link is issued**, not when the bytes are fetched.
- **No CSP violation reporting endpoint**, no `security.txt`, no `__Host-` cookie prefix, no HSTS preload.
- **Platform sign-in is not limited to known networks.**

## 9. Sign-off

The exit criteria of Phase 9 are met locally: the per-category security tests are green, the internal checklist
(§3) has no open P0 or P1, and this document is final. The items in §8 are the owner's to close before go-live.
