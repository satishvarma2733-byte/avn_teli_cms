# API specification — aVn CMS

> Every HTTP route the app serves, how to call it, and what it returns. The routes are the files under
> `avn_cms/apps/web/src/app/api/**/route.ts`; a test walks that tree against the rules below
> (`tests/integration/security-http.int.test.ts`), so this list cannot silently fall behind: a route that is not
> gated fails the build. Machine intake has its own contract in `WEBLEADS_COMPATIBILITY.md`; permissions in
> `RBAC_MATRIX.md`; background jobs in `IMPORT_EXPORT.md`, `DOCUMENTS.md`, `AUTOMATION.md`.

## 1. Conventions

**Base and format.** Same origin as the app, `/api/...`, JSON in and out (`Content-Type: application/json`;
uploads use `multipart/form-data` or a signed upload URL). Anything else on a mutating request is refused with 422
before it is read.

**Success:** `{ "data": … , "meta": { … } }` (`meta` only when there is something to say, for example
`nextCursor` and `total`). **Failure:** `{ "error": { "code", "message", "details"? } }`.

| `code` | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session (or two-step verification not finished) |
| `FORBIDDEN` | 403 | The role may not do this, a CSRF/origin check failed, or a required setup (two-step) is pending |
| `NOT_FOUND` | 404 | Does not exist **or is not yours** (the two are indistinguishable on purpose) |
| `CONFLICT` | 409 | State clash: duplicate phone, already converted, already logged, plan limit (`details.code = "PLAN_LIMIT"`) |
| `VALIDATION_ERROR` | 422 | Bad input; `details.fields` maps field name to message |
| `RATE_LIMITED` | 429 | Over the route's per-minute limit; `Retry-After` says when to retry |
| `INTERNAL` | 500 | Our fault; the message ends with a short reference that matches `requestId` in the logs |
| `UNAVAILABLE` | 503 | A service the request needs (document storage, the scanner) is not set up or not reachable |

Clients branch on `code`, never on the message. **Every response carries `X-Request-Id`**; quote it when reporting a
problem.

**Authentication.** A session cookie (`avn_session`, httpOnly, SameSite) set by `POST /api/auth/login`. The workspace
is taken from the session, never from the URL or body. **Mutating requests** (POST, PUT, PATCH, DELETE) must also send
the session's CSRF token in `X-CSRF-Token` (the app's pages read it from the page) and, from a browser, come from the
app's own origin. Machine intake routes use HTTP Basic credentials instead (§12).

**Authorization.** Each route names a policy action or the roles allowed; it is checked *before the body is read*.
The service then checks the record (ownership, workspace). The Action column below is the policy action
(`RBAC_MATRIX.md`); "any" means any signed-in role, with the record-level scope that role has.

**Pagination.** Lists use keyset cursors: `?limit=` (default 30–50, max 100) and `?cursor=` from the previous
`meta.nextCursor`. Cursors are opaque and tied to the sort.

**Rate limits.** Per user and route per minute (default 300; the limit is in the table when it differs), per address
for public routes, plus a lower cap for requests with no session. The address is the one our own proxy saw
(`TRUSTED_PROXY_HOPS`).

## 2. Health and monitoring (no session)

| Method and path | Purpose |
|---|---|
| `GET /api/health` | `200` or `503` with `status`, `database`, `redis`, `storage`, `scanner`, `worker` (each `up`, `down` or `not_configured`). Only the database and Redis change the status code. |
| `GET /api/metrics` | Prometheus text. `404` unless `METRICS_TOKEN` is set, then `Authorization: Bearer <token>`. Counts and timings only. |

## 3. Sign-in and account

| Method and path | Access | Purpose |
|---|---|---|
| `POST /api/auth/login` | public, browser only, 10/min | `{ workspace, email, password }`; one answer for every kind of failure; may return `mfaRequired` |
| `POST /api/auth/logout` | session | End this session |
| `POST /api/auth/forgot-password` | public, 5/min | Always the same answer; sends a link when the account exists |
| `POST /api/auth/reset-password` | public, 10/min | `{ token, password }`; single use, expires |
| `POST /api/auth/mfa/enroll`, `/confirm` | session | Start and finish two-step verification (needs the password) |
| `POST /api/auth/mfa/verify` | session, MFA pending | Authenticator code or a recovery code |
| `POST /api/auth/mfa/disable`, `/recovery-codes` | session | Turn off (needs password); make ten new recovery codes |
| `GET /api/auth/sessions` · `DELETE /api/auth/sessions` · `DELETE /api/auth/sessions/{id}` | session | Devices; sign out all others; sign out one |
| `POST /api/account/password` | session, 10/min | Change own password (signs out other devices) |

## 4. Students and leads

| Method and path | Action | Purpose |
|---|---|---|
| `GET /api/students` | any (scoped) | The lead list. Query: `view` (all, mine, today, overdue, potential, hot, unassigned, closed), `stage`, `sourceId`, `counselorId`, `telecallerId`, `state`, `district`, `q` (name, parent, phone digits, email), `sort`, `limit`, `cursor`. `meta`: `nextCursor`, and on the first page `total` with `totalExact` (false = "1,000+") |
| `POST /api/students` | `student:create` | Add a student and their first lead; 409 on an existing phone number |
| `PATCH /api/students/{id}` | `student:update` | Contact details |
| `DELETE /api/students/{id}` | `student:delete` | Soft delete the student, their leads; open calls are closed |
| `POST /api/students/bulk` | `student:bulk` | `{ ids, action: reassign \| stage \| block, … }` |
| `GET /api/students/template` | any | CSV import template |
| `GET /api/leads/{id}` | any (own) | Lead detail |
| `PATCH /api/leads/{id}` | per field | Stage (with reason when closing), assignments, potential/HOT, priority, interest |
| `GET /api/leads/{id}/timeline` | any (own) | Activity feed; `limit`, `cursor` |
| `POST /api/leads/{id}/notes` | `note:add` | Add a note |
| `GET /api/directory` | any | Lookup lists for forms and filters: `kind=sources`, `counselors` or `telecallers` (assignees only for callers who can assign) |

## 5. Follow-ups

| Method and path | Action | Purpose |
|---|---|---|
| `GET /api/followups` | `followup:view` (own for non-admins) | `bucket=today \| upcoming \| overdue \| pending \| closed`, `assigneeId` (admin), `limit`, `cursor`; `?counts=1` returns the tab badge counts instead |
| `POST /api/followups` | `followup:schedule` | `{ leadId, scheduledAt, assigneeId?, priority?, note? }` |
| `PATCH /api/followups/{id}` | schedule or log | Reschedule `{ scheduledAt }`, or log `{ disposition, outcomeNote?, applyStage?, nextCallAt? }` (`FOLLOWUP_ENGINE.md`) |

## 6. Web leads and intake settings

| Method and path | Action | Purpose |
|---|---|---|
| `GET /api/web-leads` · `GET /api/web-leads/{id}` | `webLead:view` | Inbox (counselors: those routed to them) |
| `PATCH /api/web-leads/{id}` | admin | Status: `NEW`, `DUPLICATE`, `SPAM`, `REJECTED` (`CONVERTED` is set by converting) |
| `POST /api/web-leads/{id}/convert` | `webLead:convert` | `{ counselorId?, telecallerId?, attachToStudentId? }` |
| `GET, POST /api/settings/intake-credentials` | `intakeCredential:manage` | List; create (secret shown once) |
| `POST /api/settings/intake-credentials/{id}/rotate` · `DELETE …/{id}` | same | Rotate (24-hour overlap); revoke |

## 7. Reports, audit, notifications

| Method and path | Action | Purpose |
|---|---|---|
| `GET /api/reports/{report}` | any (own for non-admins), 120/min | `dashboard`, `funnel`, `sources`, `team`, `status`, `followups`; query `dateFrom`, `dateTo`, `sourceId`, `state`, `assigneeId` (`REPORTING.md`) |
| `GET /api/audit` | `audit:view` | Audit log; filters `action` (prefix), `entityType`, `entityId`, `actorId`, `dateFrom`, `dateTo` (`AUDIT_LOGGING.md`) |
| `GET /api/notifications` · `GET /api/notifications/unread` · `POST /api/notifications/read` | any (own) | Inbox, badge count (600/min), mark read |
| `GET /api/usage` | `billing:view` | The agency's plan, limits and use |

## 8. Imports and exports

| Method and path | Action | Purpose |
|---|---|---|
| `GET, POST /api/imports` | `import:run` | List; upload a CSV/XLSX (20/min) |
| `GET, DELETE /api/imports/{id}` | `import:run` | Status and problem report; cancel |
| `POST /api/imports/{id}/validate` · `POST /api/imports/{id}/run` | `import:run` | Map columns and check (dry run); run with a duplicate mode (`skip`, `update`, `merge`) |
| `GET, POST /api/exports` · `GET /api/exports/{id}` | any (scoped) | List; request a CSV/XLSX/PDF export (20/min); status with a signed, expiring link |
| `GET /api/files/{id}` | any (scoped) | Download through a signed link (`exp`, `sig`) |

## 9. Documents

| Method and path | Access | Purpose |
|---|---|---|
| `GET, POST /api/documents` | any (scoped) | List; start an upload (returns a signed storage URL) |
| `POST /api/documents/{id}/complete` | any (scoped) | The upload finished: queue the virus scan |
| `GET /api/documents/{id}` · `DELETE …` | any (scoped) | Details; delete |
| `GET /api/documents/{id}/url` | any (scoped) | A signed download link once the file is clean (audited) |
| `POST /api/documents/{id}/rescan` · `GET /api/documents/stuck` | admins | Scan again; files whose scan gave up |
| `GET, POST /api/folders` · `PATCH, DELETE /api/folders/{id}` | admins | The agency's folder vault |
| `GET /api/students/{id}/documents` · `PATCH /api/students/{id}/documents/{docType}` | any (own) | A student's checklist; verify or reject an item |

## 10. People and settings

| Method and path | Action | Purpose |
|---|---|---|
| `GET, POST /api/users` | `user:list`, `user:manage` | Team; invite |
| `PATCH, DELETE /api/users/{id}` | `user:manage`, `user:delete` | Edit, change role, pause; delete |
| `POST /api/users/{id}/reset-password` | `user:resetPassword` | Start a reset for someone |
| `POST /api/users/{id}/transfer-leads` | `user:manage` | Move leads and open calls to a colleague |
| `GET, PATCH /api/settings` | `settings:manage` | Time zone, round-robin, uncontacted minutes |
| `POST /api/settings/sources` · `PATCH /api/settings/sources/{id}` | `settings:manage` | Lead sources |
| `GET, POST /api/automations` · `PATCH, DELETE /api/automations/{id}` | `automation:manage` | Rules |
| `GET /api/automations/runs` · `POST /api/automations/starter` | `automation:manage` | Run log; install the starter rules |

## 11. Platform (super admin only, no workspace)

| Method and path | Purpose |
|---|---|
| `GET, POST /api/platform/tenants` | Agencies with plan and use; create one (with its first admin) |
| `PATCH /api/platform/tenants/{id}` | Pause or resume |
| `PATCH /api/platform/tenants/{id}/plan` | `{ planCode }`; 409 when the agency uses more than the new plan allows |
| `POST /api/platform/tenants/{id}/impersonate` · `DELETE /api/platform/impersonation` | Start and stop an audited impersonation |

## 12. Machine intake (credentials, not sessions)

| Method and path | Purpose |
|---|---|
| `POST /api/webleads` | LeadXP-compatible endpoint; HTTP Basic with an intake credential; accepts both eWings payload shapes |
| `POST /api/public/web-leads` · `POST /api/public/webhooks/leads` | Same pipeline, other payload conventions |

Contract, payload mapping, idempotency and the error table: `WEBLEADS_COMPATIBILITY.md`. Credentials can create web
leads and nothing else; limits are per credential and per address.
