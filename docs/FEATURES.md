# Features — aVn CMS

> Everything the product does today, by area, with where it is documented and tested. "Built" means it runs and its
> tests pass locally (`BUILD_STATUS.md`); "Planned" items are in `IMPROVEMENT_ROADMAP.md`. Requirement ids (R-nn) are
> from `REQUIREMENTS.md`.

## 1. Workspace, people and access

| Feature | Notes | Docs |
|---|---|---|
| Multi-tenant workspaces | Tenant from the session; scoped data client; row-level security (R-01…R-03) | `ARCHITECTURE.md` §2 |
| Four roles, server-enforced | Super Admin, Tenant Admin, Counselor, Telecaller; 37 actions; 404 for what is not yours (R-10, R-11) | `USER_ROLES.md`, `RBAC_MATRIX.md` |
| Sign-in | Workspace + email + password, Argon2id, lock-out, password reset (R-06, R-07, R-09) | `SECURITY.md` §2.1 |
| Two-step verification | Authenticator app, ten recovery codes, can be required per role (R-08) | `SECURITY.md` §2.1 |
| Sessions | 7 days, idle 48 h, device list, sign out others | `SECURITY.md` §2.1 |
| Users | Invite, role, pause, reset password, transfer leads, delete; last-admin guard | `USER_ROLES.md` §3 |
| Settings | Time zone, round-robin, uncontacted minutes, lead sources | `PAGES_AND_ROUTES.md` |
| Audit log | Every change, who/what/before/after/where; admin viewer (R-13) | `AUDIT_LOGGING.md` |
| Platform console | Agencies, pause, plan, usage, audited impersonation, metrics (R-15) | `USER_ROLES.md` §5 |

## 2. Students and leads

| Feature | Notes | Docs |
|---|---|---|
| Student ≠ lead; phone-number dedupe | Unique per workspace among live students; email is a soft flag (R-20) | `STUDENT_LIFECYCLE.md` |
| Lead workspace | Server-side search and filters, keyset pagination, virtualised rows, saved views, "1,000+" totals (R-21) | `SCALABILITY.md` §4 |
| Search | Name, parent's name, phone digits (and email for those who may see it), index-backed at a million leads | `SCALABILITY.md` §4 |
| Add Student | Phone format, duplicate detection, assignment (R-22) | `STUDENT_LIFECYCLE.md` §2 |
| Lead detail | Overview, timeline, follow-ups, documents, notes (R-23) | `STUDENT_LIFECYCLE.md` §6 |
| Pipeline | 18 stages, stage history on every change, reason when closing (R-24) | `STUDENT_LIFECYCLE.md` §3 |
| Potential / HOT, interest country and course | Markers on any lead (R-25) | |
| Assignment | One active counselor and telecaller per lead with history; round robin (R-27) | `STUDENT_LIFECYCLE.md` §5 |
| Bulk actions, soft delete, block | Admin: reassign, set stage, block (R-26) | |
| Notes and activity timeline | Append-only feed per lead (R-30, R-32) | `AUDIT_LOGGING.md` §1 |

## 3. Calls

| Feature | Notes | Docs |
|---|---|---|
| Call queue | Today, Upcoming, Pending, Overdue, Closed; own queue for callers (R-28) | `FOLLOWUP_ENGINE.md` |
| Schedule, reschedule, log | 10 dispositions; a disposition may suggest a stage (R-29) | `FOLLOWUP_ENGINE.md` §3–4 |
| Overdue and escalation | Worker flags overdue calls; escalation is an automation rule (R-31) | `FOLLOWUP_ENGINE.md` §5 |
| Click-to-call | `tel:` links only; real telephony planned (R-51) | `IMPROVEMENT_ROADMAP.md` |

## 4. Intake

| Feature | Notes | Docs |
|---|---|---|
| Web-leads inbox | Review, convert, mark duplicate, spam or rejected (R-40) | `STUDENT_LIFECYCLE.md` §2 |
| LeadXP-compatible endpoint | `POST /api/webleads`, both eWings payload shapes, Basic auth (R-42) | `WEBLEADS_COMPATIBILITY.md` |
| Public endpoints | `/api/public/web-leads`, `/api/public/webhooks/leads` (R-41) | `API_SPEC.md` §12 |
| Intake credentials | Create, rotate with a 24-hour overlap, revoke; audited | `SECURITY.md` |
| Import wizard | CSV/XLSX, dry run, column mapping, duplicate modes, round robin, problem report, 50,000-row tested (R-45) | `IMPORT_EXPORT.md` |
| Exports | CSV/XLSX/PDF as background jobs, signed expiring links, role-limited columns (R-46) | `IMPORT_EXPORT.md` |

## 5. Documents

| Feature | Notes | Docs |
|---|---|---|
| Folder vault and per-student checklist | Versions, verify or reject (R-47) | `DOCUMENTS.md` |
| Cloudflare R2 storage | Presigned browser uploads and downloads; tested on MinIO | `DOCUMENTS.md` §9 |
| Virus scan before release | ClamAV; nothing is served until clean; stuck scans listed and re-scannable | `DOCUMENTS.md` §3, §10a |

## 6. Automation and notifications

| Feature | Notes | Docs |
|---|---|---|
| Rules | Trigger → conditions → actions; four triggers, five actions; run log (R-48) | `AUTOMATION.md` |
| Starter rules | New web lead → round robin; uncontacted → notify; overdue → escalate; interested → follow-up; enrolled → stop reminders | `AUTOMATION.md` §1 |
| Notifications | In-app inbox and unread badge (R-49); email and push planned | |

## 7. Reporting

| Feature | Notes | Docs |
|---|---|---|
| Dashboards | Role-aware cards, call queue, activity, funnel, trend (R-43) | `REPORTING.md` §4 |
| Reports | Funnel, sources, stage distribution, team (with conversion), follow-ups; date/source/state/person filters (R-44) | `REPORTING.md` §3 |
| Answer cache | One minute for agency-wide figures, stale-while-revalidate | `REPORTING.md` §5 |

## 8. Plans and usage

| Feature | Notes | Docs |
|---|---|---|
| Plans with limits | Users, leads, storage; missing = unlimited (R-50) | `SCALABILITY.md` §7 |
| Limits enforced where things are added | Users, students, converted web leads, imports, uploads; web-lead intake is never blocked | `SCALABILITY.md` §7 |
| Usage view and monthly snapshot | Settings card for admins; `usage_counters` for billing | `SCALABILITY.md` §7 |
| Plan change | Platform console; refused when the agency is over the new limits | `USER_ROLES.md` §5 |

## 9. Operations

| Feature | Notes | Docs |
|---|---|---|
| Health, metrics, request ids, structured logs | `/api/health`, token-protected `/api/metrics`, access log, worker heartbeat | `RUNBOOK.md` §2 |
| Backups and restore drill | `pnpm restore:drill` proves a dump restores and matches | `RUNBOOK.md` §5 |
| Load test | Seeds and drives a million-lead workspace | `SCALABILITY.md` |
| CI and security scans | Lint, types, unit, integration, browser tests; dependency, secret and CodeQL scans | `TEST_PLAN.md`, `SECURITY.md` §2.6 |

## 10. Not built (by decision or pending a provider)

WhatsApp, SMS, email campaigns, real telephony, payments and invoicing, AI features, outbound forwarding to LeadXP,
saved report views, scheduled reports, passkeys. See `IMPROVEMENT_ROADMAP.md` and `AI_ROADMAP.md`.
