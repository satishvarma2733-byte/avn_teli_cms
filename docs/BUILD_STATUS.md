# Build Status — aVn CMS

> Live record. A module is **Verified** only when its behaviour runs and its checks pass.
> Code: `avn_cms/`. Last updated: 2026-10-17.

**Overall status: PHASES 1–10 IMPLEMENTED AND VERIFIED LOCALLY — NOT YET RUN ON A REAL HOST**

All ten phases of `DEVELOPMENT_PHASES.md` are implemented and verified locally (with the gaps listed below). Phase 7 (documents) was verified against MinIO and ClamAV, **not against a real Cloudflare R2 bucket**: that needs your R2 account and keys (you will supply them through `.env`). Phase 10 (production readiness) met its exit criteria on a laptop: the load test at 1,000,000 leads is within its latency targets with no errors (`SCALABILITY.md`), the restore drill succeeds (`RUNBOOK.md` §5), the runbook is written, and all suites pass. What remains is the owner's: a hosting target, an independent penetration test, real R2/ClamAV, and a first run on staging (`IMPROVEMENT_ROADMAP.md` P0).

## Phases

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Planning docs | Done | `docs/*.md` |
| Discovery | Audit + requirements | Done | `PROJECT_AUDIT.md`, `REQUIREMENTS.md` |
| 1 | Foundation: schema, RLS, auth, tenants, RBAC, shell | **Verified** | tenancy/auth integration suites; RBAC matrix unit test (every cell); e2e sign-in, CSP, RBAC |
| 2 | Students/leads workspace & CRUD | **Verified** | leads integration suite; e2e lead journey; load-tested at 1,000,000 leads in Phase 10 (search, filters and totals were reworked as a result) |
| 3 | Assignments + follow-up engine + timeline | **Verified** | follow-up integration suite (queue, dispositions, escalation sweep); e2e log-call flow |
| 4 | Dashboards & reports | **Verified** | reports reconciliation suite; e2e. Phase 10 rewrote the dashboard queries and added a one-minute shared answer cache, after the load test showed the old dashboard taking 21 s at 1M leads |
| 5 | Web leads + LeadXP-compatible `/api/webleads` | **Verified locally** | 12 contract tests (both eWings payload shapes), HTTP smoke script 7/7, e2e intake → convert |
| 6 | Import / export | **Verified** | Migrations `import_export` (`stored_files`, job states, RLS) and `job_heartbeat`; core `imports/`, `exports/`, `storage/`, `jobs/` (queue, runner, recovery); import wizard (`/app/imports`) with a stopped-import screen and start over, Export dialogs on Leads and Web leads, `/app/exports`; API routes; worker queues `avn-jobs` and `avn-system` (stuck-jobs sweep). Tests: import unit 10/10; imports int 7/7; 50k-row int 1/1 (50,100 rows: 3.3 s check, 93 s total); exports int 7/7; recovery int 6/6; **queue int 2/2 against real Redis**; queue-refused-a-job int 6/6; migration guards 3/3; e2e 5/5. See `IMPORT_EXPORT.md` |
| 7 | Documents vault (Cloudflare R2) | **Verified locally** (gap: not yet run against real R2) | Migrations `documents_vault` and `documents_version_unique`; core `documents/` (R2 driver, ClamAV client, service, scan job, housekeeping); folder vault (`/app/documents`) and a Documents tab with the checklist on each lead; presigned browser uploads; files unavailable until a clean scan; audited downloads. Tests: unit 18; integration 21 on real MinIO + ClamAV (an infected EICAR file never downloadable, counselor scope, versions, purge) and 1 through the real Redis queue; e2e 6 (real browser upload to MinIO, scan, download, blocked file; an admin can see files whose scan gave up and scan them again). Storage and scanner health are reported by `/api/health`. See `DOCUMENTS.md` |
| 8 | Automation rules | **Verified locally** | Migration `automation_engine` (starter keys, run bookkeeping, web-lead routing; gives every existing workspace the overdue-escalation rule); core `automation/` (rule definitions, matching, actions, runner, sweep, rules service) and `notifications/`; `afterCommit` hook in `@avn-cms/db`; Automations page (rule list, rule builder, run log) and Notifications inbox with an unread badge; counselors now see the web leads routed to them. Tests: unit 25 (definitions, matching, starter rules); integration 32 (all five starter rules fire, a rule that is off never runs, all-or-nothing runs with retries, tenant scoping, a dead worker loses nothing) + 6 for `afterCommit` + 2 on real Redis (a queued run is carried out; the sweep queues a lost hand-over); e2e 8 (every starter rule fires, rule builder, routed web lead through to the counselor, off rule, admins only, phone width). See `AUTOMATION.md` |
| 9 | Security hardening | **Verified locally** (independent pen test still to do) | Internal pen-test checklist run as tests: every route against CSRF, cross-site and sign-in rules; 35 cross-workspace operations; the RBAC matrix on every route; injection, XSS, open redirect, headers and CSP in a real browser. 15 findings, no P0/P1, all fixed (client-address spoofing, second-factor brute force and replay, recovery codes, enumeration through the pause message, open redirect, authorization after validation, credential columns readable by the app role, 18 dependency advisories). Migration `security_hardening`; CI with dependency, secret and CodeQL scanning; `SECURITY.md` final. Tests: unit +34, integration +49 (security-http, security-tenant, mfa), e2e +9 |
| 10 | Production readiness | **Verified locally** (no host yet) | Load test at 1,000,000 leads (0 errors; p95 211 ms at the target pace; 117 requests a second with three servers) and the findings fixed on the way (student search through a tenant-locked function because row-level security blocks trigram indexes, list totals capped at "1,000+", dashboard rewritten and cached: `SCALABILITY.md` §4); migrations `scale_indexes` and `student_search`; plan limits enforced and usage metered monthly, with a platform plan change and a usage card; observability (request ids, access log, `render error`, worker heartbeat in `/api/health`, token-protected `/api/metrics`); backup and restore drill (`pnpm restore:drill`); `RUNBOOK.md`, `SCALABILITY.md`, `TEST_PLAN.md` and the other spec docs; rate-limit reads and writes counted apart. See each doc |

## Modules

| Module | State | Notes |
|---|---|---|
| Auth (login, sessions, lockout, reset, MFA/TOTP, sessions list, sign out others) | Verified | Workspace + email + password; Argon2id; DB sessions; CSRF token per session |
| Tenancy (scoped client + RLS on `avn_app`) | Verified | Raw SQL as `avn_app` can't read/write another tenant, sessions, or rewrite audit |
| RBAC (37 actions × 4 roles) | Verified | Pure policy + per-field checks; 404 for others' records |
| Students/leads (create, dedupe, search, filters, views, keyset pagination, stage, potential/HOT, assignment, notes, bulk, soft delete) | Verified | |
| Follow-ups (queue buckets, schedule, reschedule, disposition logging, suggested stage, next call) | Verified | |
| Activity timeline, stage history, audit log + viewer | Verified | Append-only enforced by grants |
| Worker (BullMQ: repeatable overdue sweep, expired-file cleanup, stuck-jobs sweep, documents housekeeping, automation sweep, `avn-jobs` consumer for imports, exports, document scans and automation runs) | Verified | Sweeps covered by integration tests; the `avn-jobs` queue and the worker's consumer run imports, exports, document scans and automation runs against a real Redis (`bullmq-jobs.int.test.ts`) |
| Web leads inbox (status, flags, convert/attach, spam/reject) | Verified | |
| Intake credentials (create/rotate with 24 h overlap/revoke) | Verified | |
| Import wizard and export jobs (dry run before any write, duplicate modes, round robin, signed expiring downloads) | Verified | Problem reports; 50k-row exit test; role-limited exports |
| Documents vault: folders, versioned files, per-student checklist, signed uploads and downloads, antivirus scan before release | Verified (on MinIO + ClamAV) | The R2 driver is the S3 API with signed URLs; R2-specific behaviour (CORS, checksums) follows its documentation and is untested on a real bucket |
| Dashboards (role-aware) + Reports (funnel, sources, team, stage, calls) | Verified | Charts: one validated hue, HTML bars/columns, table view |
| Users (invite, role, disable, reset, transfer-on-delete, delete) | Verified | Last-admin and self-change guards |
| Settings (timezone, round-robin, uncontacted minutes, lead sources) | Verified (UI + API) | `uncontactedMinutes` is the default waiting time of the "uncontacted" rules |
| Platform (agencies, suspend, audited impersonation, metrics) | Verified | |
| Automation rules (4 triggers, 5 actions, 5 starter rules, run log, tenant-scoped, audited) | Verified | Runs are recorded with the change and handed to the queue after the commit; the worker's sweep covers time-based rules and recovers lost hand-overs; actions never start other rules. `AUTOMATION.md` |
| Notifications (inbox, unread badge, mark read) | Verified | In-app only: no email or push; the badge is checked every minute |
| Two-step verification (authenticator app, one-time recovery codes, required roles) | Verified | Password to enrol; a code works once; five wrong codes pause checks; recovery codes stored as keyed hashes; `MFA_REQUIRED_ROLES`. `SECURITY.md` §2.1 |
| Request gate (policy action/roles before the body, CSRF, cross-site, JSON only, rate limits, trusted-proxy client address) | Verified | Every route is checked by tests generated from the file system. `SECURITY.md` §2.2 |
| Plans, limits and usage metering | Verified | `plans.limits` (users, leads, storage) enforced where things are added; website enquiries never refused; hourly monthly snapshot into `usage_counters`; Settings usage card; platform plan change refused when over the new limits. No payments. `SCALABILITY.md` §7 |
| Scale (1M leads) | Verified (laptop) | Search via `search_student_ids`, "1,000+" totals, dashboard and report answers cached for a minute (`REPORT_CACHE_SECONDS`), covering indexes. `SCALABILITY.md` |
| Observability and operations | Verified | `X-Request-Id` on every API answer, JSON access/error logs, `instrumentation.ts` render errors, worker heartbeat, `/api/health` with `worker`, `/api/metrics` (Prometheus), restore drill, runbook. `RUNBOOK.md` |
| CI (lint, types, formatting, unit, integration, browser) and security scans (dependencies, secrets, CodeQL) | Written, **not yet run on GitHub** | `.github/workflows`; the same commands pass locally |

## Tests (actual results, 2026-10-26, local Windows 11, Node 24.14, Postgres 17)

| Suite | Command | Result |
|---|---|---|
| Lint (incl. architecture import boundaries) | `pnpm lint` | pass, 0 warnings |
| Format | `pnpm format:check` | pass |
| Typecheck (6 packages) | `pnpm typecheck` | pass |
| Unit | `pnpm test:unit` | **285 passed** (the answer cache, request metrics, log and heartbeat helpers and plan-limit parsing added in Phase 10; RBAC matrix, TOTP RFC 6238 vectors, crypto, phone, cursors, intake normaliser, tenant-model list, import parsing and mapping, document types, file signatures, the clamd protocol, automation definitions and matching, client address and redirect rules, password rules, recovery codes, page security policy, code rules for routes and pages) |
| Integration (real Postgres, RLS; the queue test also needs the docker Redis, the documents tests MinIO and ClamAV) | `pnpm test:integration` | **237 passed in 24 files** (Phase 10 added lead search and totals, the big-workspace reports and cache, plans and usage over HTTP, and operations: health, metrics, heartbeat, request ids, the cache on real Redis; tenancy, auth, leads, follow-ups, web-leads contract, reports, users/platform, health, imports incl. the 50k-row run, exports, recovery of cut-off jobs, the job queue on real Redis, documents, automation, the after-commit hook, two-step verification and session lifetime, the request gate on every route, cross-workspace and role checks on every route) |
| End-to-end (production build, Chromium, axe WCAG A/AA serious+critical) | `pnpm test:e2e` | **48 passed** (sign-in, automation, leads, RBAC, security headers/CSP/XSS/redirects/two-step verification, users, web-leads intake, import wizard incl. a cut-off import and start over, exports, documents; Phase 10 added plan and usage, including a platform plan change, and a telecaller working the call queue) |
| Production build | `pnpm build` | pass (all pages dynamic for CSP nonces) |
| HTTP smoke, LeadXP-compatible intake | `pnpm smoke:webleads --url http://localhost:3300 --tenant demo` | 7/7 (246 ms first request) |

Not run: WebKit/Firefox e2e; tests against a real staging host or a production-sized machine; a database larger than memory; several agencies loaded at once; a worker process killed mid-run (the cut-off is reproduced through the database and by failing a live run). The load test at 1,000,000 leads and the restore drill are Phase 10 results: `SCALABILITY.md`, `RUNBOOK.md` §5.

## Security status

Complete description, the penetration-test checklist with its tests and the findings: `SECURITY.md`.

In short: tenant from the session only; scoped client + RLS, and the application database role cannot read
password hashes or MFA secrets; append-only audit grants; Argon2id, lock-out, identical answers for every
sign-in failure; two-step verification with replay protection, attempt limits and recovery codes (required
for chosen roles); platform sessions of 12 hours; policy check, CSRF, cross-site and content-type rules on every
route before the body is read; per-route rate limits on the address our own proxy saw; strict CSP with a
per-request nonce, HSTS on HTTPS and no inline styles except attributes; text always shown as text; formula-safe
spreadsheets; signed, expiring, per-person download links; virus-scanned documents; dependency, secret and
CodeQL scans in CI.

Open (owner): an independent penetration test and a scan of staging (OWASP ZAP); `TRUSTED_PROXY_HOPS` and
`MFA_REQUIRED_ROLES` set for the real host; passkeys; sign-in alert emails (`SECURITY.md` §8).

## Known issues

- **Phase 10, found and fixed (2026-10-17):** row-level security makes Postgres ignore the trigram indexes for the
  application role, so every student search was a table scan (3–6 s at a million leads); search now runs in a
  tenant-locked `SECURITY DEFINER` function (`SECURITY.md` §2.3, `DATABASE_SCHEMA.md`). Also: a list total used
  `ORDER BY id` and took up to 5 s (now "1,000+", counted newest-first); the dashboard took 21 s and timed out (rewritten
  and cached); the rate limit of a write was shared with reads of the same path (a counselor was refused after 60 page
  views in a minute).
- **Phase 10, open:** the "Unassigned" view walks all leads when none is unassigned (2.4 s at a million); the first look
  at a report after a quiet spell takes 1–2.5 s (then it is cached for a minute, so agency-wide figures can be a minute
  old); someone who loses both their authenticator and their recovery codes can only be helped by an operator
  (`RUNBOOK.md` §4.4); the load numbers come from one laptop sharing the generator, the servers and the database
  (`SCALABILITY.md` §8).
- **Incident (2026-10-16, local only):** a mis-quoted shell command during the docs update
  executed the README's sample commands: `cp .env.example .env` overwrote `avn_cms/.env`
  (blanking `SESSION_SECRET` and `ENCRYPTION_KEY`), and `pnpm db:migrate` / `pnpm db:seed` /
  `pnpm dev` ran. Fixed: both secrets regenerated (no dev user had MFA enrolled, so nothing
  encrypted was lost); the extra dev server was stopped; the migrate was a no-op and the seed
  skipped (dev data unchanged: 2 tenants, 8 users, 45 students). Dev sessions need a new
  sign-in. Doc edits are now done with the file editor, never with inline shell strings.

- `pg` prints a deprecation warning ("client.query() while already executing") from inside
  Prisma 7.10's query interpreter during interactive transactions. Harmless on `pg` 8; must be
  re-checked before any upgrade to `pg` 9.
- Playwright is pinned to 1.63.0 because that matches the Chromium already installed here.
- The local dev database still contains the first seed run, whose activity summaries show raw
  codes (e.g. `CALL_BACK_LATER`). The seed is fixed; resetting the dev database needs your
  go-ahead (`pnpm --filter @avn-cms/db exec prisma migrate reset`, then `pnpm db:seed`).
- Notifications are in-app only (no email or push), and the navigation badge is checked every minute rather than pushed.
- **Set `TRUSTED_PROXY_HOPS` on the real host.** The default (0) ignores `X-Forwarded-For`, which is safe but, behind a load balancer, counts every caller as one address (sign-in is then limited to 10 a minute for the whole site). Set it to the number of proxies in front of the app.
- Two-step verification is optional unless `MFA_REQUIRED_ROLES` is set (recommended in production: `SUPER_ADMIN,TENANT_ADMIN`). A role that is required but has not enrolled can only set it up and sign out.
- The new CI workflows have not run on GitHub yet (the same commands pass locally). `pnpm audit` is part of them and currently reports nothing.
- The seed (`pnpm db:seed`) does not install the starter automation rules, so the browser tests start without rules and add them from the page. In a development workspace an admin presses **Add starter rules**. Workspaces that existed when the Phase 8 migration ran got the overdue-escalation rule only.
- Time-based rules fire up to about 2 minutes late (the worker sweeps every 2 minutes) and only look at recent records (3 days for uncontacted leads, 7 days for overdue calls).
- Documents have never run against a real Cloudflare R2 bucket (no account or keys here). MinIO speaks the same S3 API and every flow is tested on it, but R2's CORS rules (`DOCUMENTS.md` §9) and its handling of signed uploads need one real try before go-live, as does the `HeadBucket` storage health probe with a bucket-scoped Object Read & Write token.
- Downloads are audited when the signed link is issued, not when the bytes are fetched.
- **Found and fixed (2026-10-16):** the Exports list (Phase 6) scrolled sideways on a phone once it had rows: the visually hidden "Action" header text is positioned against the page, not the table, so it sat off-screen at the far right and widened the page. My earlier phone check missed it because the list was empty. Fixed in the exports list and the new vault table (the scrolling wrapper is now the positioning context), and the browser tests now check phone width on the vault, exports and imports lists.
- `docker-compose.yml` uses `minio/minio:latest`, which Docker Hub no longer lets new machines pull; it works here from the local cache. If it fails for you, use another S3-compatible server (`DOCUMENTS.md` §11).
- `prisma migrate dev` hangs in this non-interactive environment; migrations here are applied with `prisma migrate deploy` and checked with `prisma migrate diff` (the only differences left are the two unmodelled indexes, `users_tenant_email_key` and the covering index `lead_status_history_funnel_idx`; never let a generated migration drop them).
- Source ROI shows conversion only: ad spend isn't recorded.
- **Found and fixed (2026-10-16):** the first test of the imports/exports queue against real Redis
  showed that, before this fix, every `enqueue` onto BullMQ threw (`Custom Id cannot contain :`), so
  with `REDIS_URL` set no import or export could start; the in-process fallback used by dev, the
  tests and e2e had hidden it. Job ids are now unique per request, which also lets a re-queued
  import ("check again", start over) run: with a repeated id BullMQ silently drops the job.
- **Found and fixed (2026-10-16):** a job whose request to the queue failed stayed QUEUED for ever
  (the stuck-jobs sweep ignores QUEUED). It also turned out that with Redis unreachable `enqueue`
  never failed at all: BullMQ keeps waiting for the connection, so the request hung. `enqueue` now
  gives up after 10 s; the import service then puts the import back to VALIDATED and the export
  service fails the export ("The export could not be started. Try again."). See `IMPORT_EXPORT.md` §7.

## External dependencies / not in scope by decision

- eWings: **compatibility only** (owner decision). `POST /api/webleads` accepts both eWings
  payloads; no eWings code was changed; switching eWings is a later configuration step.
- Outbound forwarding to LeadXP: not built; LeadXP's response contract is unverified.
- Telephony (click-to-call is `tel:` links only), WhatsApp, SMS: provider decisions needed.
- AI providers/agents and Payload CMS: not in the documented scope (`PROJECT_AUDIT.md` §4).

## Decisions requiring approval

1. **Repository:** `main` is pushed to https://github.com/satishvarma2733-byte/avn_teli_cms
   (2026-10-16, repo-local identity `opsewings`). CI and security scans are written (`.github/workflows`) and start on the next push; enable **private vulnerability reporting** and Dependabot alerts in the repository settings.
2. **Hosting target** for staging and production (Node server + Postgres + Redis).
3. **Reset the local dev database** to load the corrected seed (destructive, local only).
4. **Cloudflare R2 for staging/production:** create the bucket and an Object Read & Write token, set its CORS rules, and provide a private ClamAV host (`DOCUMENTS.md` §9–10); you will connect them later through `.env`.
5. **Before go-live:** an independent penetration test and a ZAP scan of staging; set `TRUSTED_PROXY_HOPS`, `MFA_REQUIRED_ROLES` and an `https://` `APP_URL` (`SECURITY.md` §5, §8). Phase 10 (production readiness) is done locally; the P0 list in `IMPROVEMENT_ROADMAP.md` is what stands between this and real customer data.

## Files

Code: `avn_cms/` — 318 TypeScript/TSX/SQL/CSS source files (~37k lines, excluding generated code) across
`apps/web`, `apps/worker`, `packages/{config,db,auth,core}`, `tests/`, `scripts/`.
Docs created: `PROJECT_AUDIT.md`, `REQUIREMENTS.md`, `BUILD_STATUS.md`, `DEPLOYMENT.md`, `IMPORT_EXPORT.md`, `DOCUMENTS.md`, `AUTOMATION.md`, `SECURITY.md` (and the repository's `SECURITY.md` reporting policy).
Docs updated: `README.md`, `ARCHITECTURE.md`, `MODULE_STRUCTURE.md`, `DEVELOPMENT_PHASES.md`,
`WEBLEADS_COMPATIBILITY.md`.
