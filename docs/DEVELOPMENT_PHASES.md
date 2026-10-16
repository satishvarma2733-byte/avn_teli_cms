# Development Phases

> Review item 6 of 6. The build is sequenced into 10 phases. Each phase states what it
> builds, the DB and API changes it introduces, its exit criteria, and the spec docs it
> produces. No phase starts before the previous one's exit criteria are green
> (`lint` + `typecheck` + `test` + `test:e2e`).

**Status (2026-10-16):** Phases 1–5 built and verified locally (lint, typecheck, 170 unit,
57 integration, 15 e2e — see [`BUILD_STATUS.md`](BUILD_STATUS.md) for evidence and the
remaining gaps: 100k-row load test, report caching). Phases 6–10 not started, except the
pieces noted there (round-robin, overdue escalation, health check, deployment guide).

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

**Docs:** section in `FEATURES.md` + `SECURITY.md` upload section.

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

**Docs:** section in `FEATURES.md`.

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
`IMPROVEMENT_ROADMAP.md`, `AI_ROADMAP.md`.

---

## Documentation coverage map

The spec asks for 20 Markdown docs. Here's where each is produced so none is missed:

| Doc | Produced in |
|---|---|
| README.md | Phase 0 ✅ |
| PRODUCT_OVERVIEW.md | Phase 0 (fold into README) / Phase 1 |
| FEATURES.md | grows Phases 2–8 |
| USER_ROLES.md | Phase 1 |
| RBAC_MATRIX.md | Phase 0 ✅ |
| STUDENT_LIFECYCLE.md | Phase 2 |
| FOLLOWUP_ENGINE.md | Phase 3 |
| PAGES_AND_ROUTES.md | Phase 0 ✅ |
| DATABASE_SCHEMA.md | Phase 0 ✅ (kept in sync with migrations) |
| API_SPEC.md | Phases 2–8 (per-module, consolidated) |
| SECURITY.md | Phase 1 draft → Phase 9 final |
| AUDIT_LOGGING.md | Phase 1 |
| IMPORT_EXPORT.md | Phase 6 |
| REPORTING.md | Phase 4 |
| TEST_PLAN.md | Phase 10 (suites written each phase) |
| UX_IMPROVEMENTS.md | Phase 10 (tracked throughout) |
| IMPROVEMENT_ROADMAP.md | Phase 10 (P0–P3 groups) |
| DEPLOYMENT.md | Phase 10 |
| SCALABILITY.md | Phase 10 |
| AI_ROADMAP.md | Phase 10 |
| (ARCHITECTURE.md, MODULE_STRUCTURE.md, DEVELOPMENT_PHASES.md) | Phase 0 ✅ |

---

## Open items before Phase 6

1. **Commits:** a local repository now exists at `Desktop\leadxp-rebuild` (branch `main`),
   with no commits and no git identity yet — say who commits and where it is pushed.
2. **Stack:** built as written (Next.js + Prisma + Postgres), with the documented swaps in
   `MODULE_STRUCTURE.md` → "As built" and `PROJECT_AUDIT.md` §5.
3. **Hosting target** for staging/production (Node server, Postgres 15+, Redis).
4. **Object storage** choice for Phase 7 (S3-compatible: MinIO locally).
