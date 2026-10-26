# Development Phases

> Review item 6 of 6. The build is sequenced into 10 phases. Each phase states what it
> builds, the DB and API changes it introduces, its exit criteria, and the spec docs it
> produces. No phase starts before the previous one's exit criteria are green
> (`lint` + `typecheck` + `test` + `test:e2e`).

**Status (2026-10-16):** Phases 1–7 built and verified locally (lint, typecheck, format, 200 unit, 108 integration, 26 e2e — see [`BUILD_STATUS.md`](BUILD_STATUS.md) for evidence and the remaining gaps: 100k-row load test, report caching, the documents vault not yet run against a real R2 bucket). Phases 8–10 not started, except the pieces noted there (round-robin, overdue escalation, health check, deployment guide).

**Rule for every phase (from the spec):**
*Before* — explain what will be built, list files to create/change, explain DB changes,
explain API changes. *After* — run lint, typecheck, tests; fix errors; give a concise
implementation summary.

---

## Phase 0 — Planning (this deliverable)

Produce the six foundational docs and get them reviewed. **Gate: coding does not begin
until these are approved.**

- [x] README.md
- [x] ARCHITECTURE.md
- [x] DATABASE_SCHEMA.md
- [x] RBAC_MATRIX.md
- [x] PAGES_AND_ROUTES.md
- [x] MODULE_STRUCTURE.md
- [x] DEVELOPMENT_PHASES.md  ← this file

**Exit:** owner sign-off on schema, RBAC, routes, modules.

---

## Phase 1 — Foundation: architecture, schema, auth, tenants, RBAC

The skeleton everything else stands on.

**Build:** pnpm workspace; `packages/db` with the full Prisma schema + migrations + RLS +
seed; tenant-scoped client (`db(ctx)`); `packages/auth` (login, sessions, Argon2id,
password reset, MFA scaffold); `TenantContext` builder; policy engine + the full RBAC
matrix as pure functions; `require-context` route gate; security headers + CSP in
middleware; the design-system shell (`packages/ui`, app layout, login page).

**DB:** all tables from `DATABASE_SCHEMA.md`; RLS policies; seed with a demo tenant, the
four roles, lead sources, a handful of students/leads.

**API:** `/api/auth/*`; the request-lifecycle gate; the response envelope.

**Exit:** a user can log in; session yields a tenant context; the RBAC matrix test passes
for every cell; the tenant-isolation test proves cross-tenant queries return nothing;
lint/typecheck/unit green.

**Docs produced:** `USER_ROLES.md`, `SECURITY.md` (first pass), `AUDIT_LOGGING.md`.

---

## Phase 2 — Student/Lead workspace & CRUD

The core data surface.

**Build:** Student ≠ Lead model end-to-end; the big workspace table (TanStack,
server-driven, cursor pagination, virtualized); search/filter/sort; Add Student form
(RHF + Zod) with mobile-format + duplicate-phone/email detection; lead detail (overview +
timeline shell); soft delete / block; bulk select → reassign / set stage (admin).

**DB:** indexes from the schema verified under load; dedupe partial unique index.

**API:** `/api/students*`, `/api/students/bulk`, `/api/leads/:id`, `/api/students/template`.

**Exit:** 50-row pages render instantly against a 100k-row seed; dedupe blocks a duplicate
phone; bulk reassign of 1k leads runs as a job; IDOR tests on `/api/students/:id` pass.

**Docs:** `STUDENT_LIFECYCLE.md`.

---

## Phase 3 — Assignments & the follow-up engine

The daily driver.

**Build:** counselor/telecaller assignment with history; round-robin option; the
follow-up call queue (Today/Upcoming/Pending/Overdue/Closed); schedule/reschedule;
**call disposition logging that writes to the activity timeline**; overdue detection +
escalation; the activity timeline view fully wired (the #1 gap from review).

**DB:** `follow_ups`, `activities`, `lead_assignments` indexes exercised.

**API:** `/api/followups*`, `/api/leads/:id/timeline`, assignment PATCHes.

**Exit:** a telecaller's queue loads own-only; logging a disposition appends a timeline
entry and can advance the stage; an overdue follow-up escalates via the worker; e2e flow
"schedule → call → log → reschedule" passes.

**Docs:** `FOLLOWUP_ENGINE.md`.

---

## Phase 4 — Dashboards & Reports

The owner's questions, answered.

**Build:** role-aware dashboards (cards + funnel + leaderboard + recent activity + overdue);
Reports Center — conversion funnel, source ROI, counselor/telecaller performance *with
conversion rate*, stage distribution, follow-up stats; date/source/geo/agent filters;
Recharts. Report aggregates cached in Redis; heavy ones materialized by the worker.

**API:** `/api/reports/*`.

**Exit:** funnel and source-ROI numbers reconcile against raw counts; dashboards load
under target latency with cache; counselor sees only own performance.

**Docs:** `REPORTING.md`.

---

## Phase 5 — Web Leads

Clean intake.

**Build:** external web-leads inbox; `/api/public/web-leads` + generic
`/api/public/webhooks/leads` (API key, rate-limited, Zod-validated); **dedupe on intake**
(phone → existing student); convert-to-student/lead with assignment; status
(new/duplicate/spam/rejected); CSV export. **LeadXP compatibility:** `POST /api/webleads`
accepting the live product's payloads unchanged (Basic auth via tenant intake
credentials; field normalisation; attribution columns); Settings → Integrations to
manage credentials. Spec: [`WEBLEADS_COMPATIBILITY.md`](WEBLEADS_COMPATIBILITY.md).

**DB:** `web_leads` + dedupe index + attribution columns; `intake_credentials`.

**Exit:** a repeat submission from a known phone is flagged duplicate, not duplicated; a
landing-page POST creates a lead and (optionally) round-robin-assigns it; the junk classes
seen in the live product (identical repeats, `info@` self-emails) are caught by validation;
the contract tests in `WEBLEADS_COMPATIBILITY.md` §6 pass for both recorded eWings payload
shapes; p95 intake latency under 500 ms.

**Not in this phase:** switching any live website to aVn CMS. That is a later,
configuration-only step, approved separately (`WEBLEADS_COMPATIBILITY.md` §7).

**Docs:** section added to `FEATURES.md`; `WEBLEADS_COMPATIBILITY.md` updated with what was built.

---

## Phase 6 — Import / Export

Bulk data in and out, safely.

**Build:** the 7-step import wizard (upload → map columns → validate → show errors →
duplicate behavior skip/update/merge → background import → results report); background
CSV/XLSX/PDF export jobs with signed download; downloadable template; status→field
migration map for existing LeadXP data.

**DB:** `import_jobs`, `export_jobs`.

**API:** `/api/imports*`, `/api/exports*`.

**Exit:** a 50k-row CSV imports as a job with a per-row error report; chosen duplicate
behavior is honored; exports stream from a job, never block a request.

**Docs:** `IMPORT_EXPORT.md`.

**Status (2026-10-16):** Verified locally: lint, typecheck, format, 182 unit, 72 integration (including the 50,000-row import), 19 e2e. A run cut off by a crash is recovered: the worker fails it so people can start over (see `IMPORT_EXPORT.md` §7).

---

## Phase 7 — Documents

The vault + student checklist.

**Build:** folders + file upload to S3 via presigned URLs; type/size allow-list; async
malware scan (file unavailable until `CLEAN`); signed expiring download URLs; versioning;
**per-student document checklist** (passport, NEET, marks memo, …) with
missing/verified/rejected; audit on every download.

**DB:** `folders`, `documents`, `student_documents`.

**API:** `/api/folders*`, `/api/documents*`, `/api/students/:id/documents`.

**Exit:** an infected test file never becomes downloadable; a counselor can only reach
documents of their own leads; every download is audited.

**Docs:** `DOCUMENTS.md` (the feature and its upload security; the standalone `FEATURES.md` and `SECURITY.md` arrive with Phase 10).

**Status (2026-10-16):** Verified locally on MinIO and ClamAV: lint, typecheck, format, 200 unit, 108 integration, 26 e2e. The exit criteria are tested: an infected test file never becomes downloadable, a counselor reaches only the documents of their own leads, every download is audited. Not yet run against a real R2 bucket (see `DOCUMENTS.md` §9).

**Decision (2026-10-16):** object storage is **Cloudflare R2** (S3 API, presigned URLs). The malware scan is ClamAV (`clamd`), and a file is served only after a clean verdict.

---

## Phase 8 — Automation

Rules that run the busywork.

**Build:** rule engine (trigger → conditions → actions) on the domain event bus;
starter rules — new web lead → round-robin assign; uncontacted 30 min → notify manager;
follow-up overdue → escalate; stage → interested → schedule follow-up; enrolled → stop
reminders. Rule builder UI + run log.

**DB:** `automation_rules`, `notifications`.

**API:** `/api/automations*`.

**Exit:** each starter rule fires in e2e; rules are tenant-scoped; a disabled rule never
runs; runs are logged.

**Docs:** `AUTOMATION.md` (the feature, how a run happens, the API; the standalone `FEATURES.md` arrives with Phase 10).

**Status (2026-10-17):** Verified locally: lint, typecheck, format, 225 unit, 148 integration, 34 e2e. The exit criteria are tested: each starter rule fires in the browser tests (the two time-based ones through the worker's sweep), rules and runs never cross workspaces, a rule that is off never runs, and every run is in the log.

**Decisions (2026-10-17):** a run is recorded in the transaction of the change that caused it and handed to the queue after the commit (an outbox), so nothing is lost or run for a change that rolled back; a run's actions are one transaction (all or nothing, 3 attempts); actions never start other rules; overdue escalation became a rule (the migration gives it to every existing workspace); web leads are routed with `web_leads.routed_to_id`, which is what lets counselors see "their" web leads.

---

## Phase 9 — Security hardening

Make the posture real, not aspirational.

**Build:** full rate-limit tuning; brute-force lockout; CSRF on all mutations; signed-URL
review; CSP tightening; dependency + secret scanning in CI; penetration-test checklist
run internally (IDOR/BOLA/RBAC/tenant-leak/injection/XSS/CSRF/upload/export/mass-assign);
MFA completed; active-session management + logout-other-devices.

**Exit:** the security test suite (per-category) is green; the internal pentest checklist
has no open P0/P1; `SECURITY.md` finalized.

**Docs:** `SECURITY.md` (final), `DEPLOYMENT.md` security section.

**Status (2026-10-17):** Verified locally: lint, typecheck, format, 259 unit, 197 integration, 43 e2e, `pnpm audit` clean. The exit criteria are met: the security tests run per category (`SECURITY.md` §3), the internal checklist has no open P0 or P1 (15 findings, all fixed, §4), and `SECURITY.md` is final. Not done: an independent penetration test and a DAST scan of staging, and anything that needs a real host (TLS, proxy) or Cloudflare R2.

**Decisions (2026-10-17):** the policy action or roles of a route are declared on the route and checked before its body is read; the client address is the entry our own proxy added (`TRUSTED_PROXY_HOPS`, default: ignore the header); every sign-in failure gets one answer, including a paused account; two-step verification needs the password to turn on, a code works once, recovery codes are keyed hashes, and roles can be required to use it (`MFA_REQUIRED_ROLES`); the application database role cannot read credential columns; platform sessions last 12 hours.

---

## Phase 10 — Testing & production readiness

Ship-ready.

**Build:** Playwright flows for every role and critical path; load test at target scale;
observability (structured logs, error tracking, uptime); backups + restore drill;
`DEPLOYMENT.md`, `SCALABILITY.md`, `TEST_PLAN.md` finalized; billing/usage metering wired
(loosely coupled) for the plan tiers (Starter/Professional/Ultra/Enterprise).

**Exit:** all suites green; load test meets latency targets at 1M leads; restore drill
succeeds; runbook complete.

**Docs:** `TEST_PLAN.md`, `DEPLOYMENT.md`, `SCALABILITY.md`, `UX_IMPROVEMENTS.md`,
`IMPROVEMENT_ROADMAP.md`, `AI_ROADMAP.md` — plus `RUNBOOK.md` and the eight spec documents that were still missing
(`PRODUCT_OVERVIEW`, `FEATURES`, `USER_ROLES`, `STUDENT_LIFECYCLE`, `FOLLOWUP_ENGINE`, `API_SPEC`, `AUDIT_LOGGING`,
`REPORTING`).

**Status (2026-10-26):** Verified locally: lint, typecheck, format, 285 unit, 237 integration, 48 e2e. The exit
criteria are met on a laptop: the load test at 1,000,000 leads has no errors and every kind of request inside its latency
target at the target pace (150 staff, one action each about 5 seconds: p50 48 ms, p95 211 ms, p99 428 ms, 29 requests a
second), and at 7× that pace one web server saturates at about 70 requests a second while three give 117 (`SCALABILITY.md`);
the restore drill passes (a 9.9-million-row, 3.9 GB database: 555 MB backup in 46.5 s, restored in 151.8 s, all six checks
green: `RUNBOOK.md` §5); the runbook is written. Not done: anything that needs a real host, real R2, or an outside party
(`IMPROVEMENT_ROADMAP.md` P0).

**Decisions (2026-10-26):** the load test found that **row-level security stops Postgres using trigram indexes for the
application role**, so student search runs in a tenant-locked `SECURITY DEFINER` function (`search_student_ids`); list
totals stop at "1,000+" (a count with a limit is `ORDER BY id`); dashboard and report answers are kept for a minute
(`REPORT_CACHE_SECONDS`, stale-while-revalidate, shared through Redis) while a person's own cards and queue are never
cached; plans are limits in `plans.limits` enforced where things are added, with website enquiries never refused and
usage snapshotted monthly into `usage_counters` (no payments); observability is built from standard parts (JSON logs,
`X-Request-Id`, a worker heartbeat in `/api/health`, a token-protected Prometheus `/api/metrics`) with
`shared/observability.ts` as the one place an error tracker would plug in; a write's rate limit is counted apart from
reads of the same path; `RUNBOOK.md` was added as a document of its own.

---

## Documentation coverage map

The spec asks for 20 Markdown docs. Here's where each is produced so none is missed:

| Doc | Produced in |
|---|---|
| README.md | Phase 0 ✅ |
| PRODUCT_OVERVIEW.md | Phase 10 ✅ |
| FEATURES.md | Phase 10 ✅ |
| USER_ROLES.md | Phase 10 ✅ |
| RBAC_MATRIX.md | Phase 0 ✅ |
| STUDENT_LIFECYCLE.md | Phase 10 ✅ |
| FOLLOWUP_ENGINE.md | Phase 10 ✅ |
| PAGES_AND_ROUTES.md | Phase 0 ✅ |
| DATABASE_SCHEMA.md | Phase 0 ✅ (kept in sync with migrations) |
| API_SPEC.md | Phase 10 ✅ |
| SECURITY.md | Phase 9 ✅ (Phase 10 adds the search function, logs and metrics) |
| AUDIT_LOGGING.md | Phase 10 ✅ |
| IMPORT_EXPORT.md | Phase 6 ✅ |
| REPORTING.md | Phase 10 ✅ |
| TEST_PLAN.md | Phase 10 ✅ |
| UX_IMPROVEMENTS.md | Phase 10 ✅ |
| IMPROVEMENT_ROADMAP.md | Phase 10 ✅ |
| DEPLOYMENT.md | Phase 10 ✅ |
| SCALABILITY.md | Phase 10 ✅ |
| AI_ROADMAP.md | Phase 10 ✅ |
| RUNBOOK.md (added in Phase 10: the exit criterion "runbook complete") | Phase 10 ✅ |
| (ARCHITECTURE.md, MODULE_STRUCTURE.md, DEVELOPMENT_PHASES.md) | Phase 0 ✅ |

---

## Open items

1. **CI:** the code is on GitHub (`satishvarma2733-byte/avn_teli_cms`, branch `main`); the workflows that run lint, typecheck, unit, integration, e2e and the security scans are written (`.github/workflows`) but have not run on GitHub yet.
2. **Stack:** built as written (Next.js + Prisma + Postgres), with the documented swaps in
   `MODULE_STRUCTURE.md` → "As built" and `PROJECT_AUDIT.md` §5.
3. **Hosting target** for staging/production (Node server, Postgres 15+, Redis).
4. **Object storage:** decided, Cloudflare R2 (MinIO locally). Still needed from you: an R2 bucket and API token for staging/production, and a private ClamAV host (`DOCUMENTS.md` §9–10).
