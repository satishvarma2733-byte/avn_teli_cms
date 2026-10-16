# Requirements — aVn CMS

> One line per requirement, traced to the doc that states it and the phase that builds it.
> Status is maintained in [`BUILD_STATUS.md`](BUILD_STATUS.md); this file changes only
> when scope changes.

## Platform and security

| ID | Requirement | Source | Phase |
|---|---|---|---|
| R-01 | Multi-tenant: every tenant-owned row has `tenant_id`; tenant comes from the session, never the body | ARCH §2, README | 1 |
| R-02 | Tenant-scoped data client injects `tenantId` on every read/write; raw client only in auth + super-admin | ARCH §2, MODULE | 1 |
| R-03 | Postgres RLS backstop on tenant tables (`app.tenant_id`) | ARCH §2, SCHEMA | 1 |
| R-04 | Request gate: authenticate → tenant ctx → rate limit → Zod validate → authorize → service → audit → envelope | ARCH §3 | 1 |
| R-05 | Response envelope `{data, meta?}` / `{error:{code,message,details?}}`, stable error codes | ARCH §3 | 1 |
| R-06 | Login/logout, Argon2id, httpOnly/secure/SameSite cookies, CSRF on mutations | ARCH §9 | 1 |
| R-07 | Password reset with single-use, expiring tokens | ARCH §9, ROUTES | 1 |
| R-08 | MFA (TOTP) enroll/verify; session list + revoke other devices | ROUTES, PHASES 1/9 | 1 (scaffold) / 9 |
| R-09 | Brute-force lockout with backoff; stricter auth rate limits | ARCH §9 | 1 / 9 |
| R-10 | RBAC as pure `can(ctx, action, resource)`; matrix test covers every cell | RBAC | 1 |
| R-11 | Other-user / other-tenant records return 404 (not 403) to avoid enumeration | RBAC rule 2 | 1–2 |
| R-12 | No mass assignment: services accept DTOs only | RBAC rule 4 | all |
| R-13 | Audit log for every mutation (who/what/old→new, ip, ua, impersonated_by) + admin viewer | ARCH §3, SCHEMA | 1 / 2 |
| R-14 | Security headers + CSP | PHASES 1 | 1 |
| R-15 | Super Admin: tenants CRUD/suspend, plans, audited impersonation, platform metrics (non-PII) | RBAC, ROUTES | 1 / 10 |

## CRM core

| ID | Requirement | Source | Phase |
|---|---|---|---|
| R-20 | Student (person) ≠ Lead (opportunity); dedupe students by normalized phone (unique per tenant), email as soft signal | ARCH §6, SCHEMA | 2 |
| R-21 | Workspace table: server-side search/filter/sort, cursor pagination, virtualized rows; saved views (all/mine/today…) | ROUTES, ARCH §8 | 2 |
| R-22 | Add Student form with phone format + duplicate phone/email detection | PHASES 2 | 2 |
| R-23 | Lead detail: overview, timeline, follow-ups, documents, notes | ROUTES | 2–3 |
| R-24 | Pipeline stage enum (18 values) + status history on every change | ARCH §7, SCHEMA | 2 |
| R-25 | Potential / HOT markers; interest country + course | SCHEMA | 2 |
| R-26 | Soft delete / block; bulk reassign / set stage / block (admin) | PHASES 2, ROUTES | 2 |
| R-27 | Counselor + telecaller assignment with history; round-robin option; transfer-on-delete | SCHEMA, RBAC | 3 |
| R-28 | Follow-up queue buckets Today/Upcoming/Pending/Overdue/Closed; schedule/reschedule; disposition enum (10) | ARCH §7, ROUTES | 3 |
| R-29 | Disposition logging writes an activity; may suggest a stage change | ARCH §7 | 3 |
| R-30 | Append-only activity timeline per lead/student | SCHEMA | 3 |
| R-31 | Overdue detection + escalation via worker | PHASES 3 | 3 |
| R-32 | Notes on leads, mirrored into activities | SCHEMA | 2–3 |

## Intake, reporting, operations

| ID | Requirement | Source | Phase |
|---|---|---|---|
| R-40 | Web-leads inbox; convert to student/lead with assignment; status NEW/DUPLICATE/CONVERTED/SPAM/REJECTED | ROUTES, SCHEMA | 5 |
| R-41 | `/api/public/web-leads` + `/api/public/webhooks/leads` (credential, rate-limited, Zod) | ROUTES | 5 |
| R-42 | LeadXP-compatible `POST /api/webleads` accepting both eWings payload shapes; intake credentials | WEBLEADS_COMPAT | 5 |
| R-43 | Role-aware dashboards (cards per role, funnel, leaderboard, recent activity, overdue) from real data | ROUTES | 4 |
| R-44 | Reports: funnel, source ROI, team performance with conversion rate, stage distribution, follow-up stats; date/source/geo/agent filters | ROUTES | 4 |
| R-45 | CSV/XLSX import wizard as background job with per-row error report and duplicate behaviour | PHASES 6 | 6 |
| R-46 | Background CSV/XLSX/PDF exports with signed download | PHASES 6 | 6 |
| R-47 | Documents vault: folders, S3 presigned upload, allow-list, malware scan gate, signed URLs, per-student checklist | PHASES 7 | 7 |
| R-48 | Automation rules (trigger → conditions → actions) on domain events; run log | PHASES 8 | 8 |
| R-49 | Notifications (in-app; email later) | SCHEMA | 3 / 8 |
| R-50 | Plans/subscriptions/usage metering (loosely coupled) | SCHEMA, PHASES 10 | 10 |
| R-51 | Telephony (click-to-call), WhatsApp, SMS adapters behind one interface | README, ARCH | later (provider decisions needed) |

## Quality gates

| ID | Requirement | Source |
|---|---|---|
| Q-01 | `lint` + `typecheck` + `test` + `test:e2e` green before a phase closes | PHASES |
| Q-02 | RBAC matrix test, tenant-isolation test, IDOR suite, mass-assignment suite | RBAC |
| Q-03 | 50-row pages fast against a large seed; never fetch all rows | README, PHASES 2 |
