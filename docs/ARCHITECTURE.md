# Architecture

> Review item 1 of 6. Defines the system shape, the multi-tenancy model, the request
> lifecycle, and the layering every module must follow. Read this before the schema —
> the schema is a consequence of the decisions here.

---

## 1. System overview

aVn CMS is a single Next.js application (App Router) backed by PostgreSQL, Redis and
S3-compatible object storage. It serves four roles (Super Admin, Tenant Admin,
Counselor, Telecaller) across many tenants (agencies), with strict data isolation
between tenants.

```
                         ┌───────────────────────────────────────────┐
   Browser (role-aware)  │              Next.js app                   │
   ──────────────▶       │                                           │
                         │  ┌─────────────┐    ┌──────────────────┐  │
   Website forms ───────▶│  │ Route layer │──▶ │ Service layer    │  │
   (web-lead webhook)    │  │ (API + RSC) │    │ (business logic) │  │
                         │  └─────────────┘    └────────┬─────────┘  │
   WhatsApp/Telephony ──▶│         │                    │            │
   webhooks              │  ┌──────▼──────┐    ┌────────▼─────────┐  │
                         │  │ Auth +      │    │ Repository /     │  │
                         │  │ RBAC +      │    │ data layer       │  │
                         │  │ tenant ctx  │    │ (Prisma)         │  │
                         │  └─────────────┘    └────────┬─────────┘  │
                         └──────────────────────────────┼────────────┘
                                                         │
                    ┌───────────────┬────────────────────┼───────────────┐
                    ▼               ▼                    ▼               ▼
              ┌───────────┐   ┌───────────┐       ┌───────────┐   ┌───────────┐
              │ Postgres  │   │  Redis    │       │   S3      │   │ Worker    │
              │ (primary) │   │ cache+BullMQ│     │ documents │   │ (BullMQ)  │
              └───────────┘   └───────────┘       └───────────┘   └───────────┘
```

**Worker process:** the same codebase runs a second entrypoint (`worker`) that consumes
BullMQ queues for CSV imports, exports, follow-up reminders, automation rules and
outbound messaging. It is deployed as a separate process/container but shares the
service and repository layers — no business logic is duplicated.

---

## 2. Multi-tenancy model

**Decision: shared database, shared schema, row-level tenancy by `tenant_id`.**

Every tenant-owned table carries a non-null `tenant_id` (FK → `tenants.id`). This is the
cheapest model to operate at the expected scale (dozens to low-hundreds of agencies,
millions of leads total) and keeps migrations single-track.

The isolation guarantees come from three enforced layers, not from discipline alone:

1. **Session-derived tenant context.** On every authenticated request a `TenantContext`
   `{ tenantId, userId, role }` is built from the session. The client never sends
   `tenant_id`; any `tenant_id` in a request body is ignored.
2. **A tenant-scoped Prisma client.** The repository layer uses a Prisma client wrapped
   with a [client extension](https://www.prisma.io/docs/orm/prisma-client/client-extensions)
   that injects `where: { tenantId }` into every `find/update/delete` and sets `tenantId`
   on every `create`, for tenant-owned models. A raw/un-scoped client exists **only** in
   the `super-admin` and `auth` modules and is lint-forbidden elsewhere.
3. **Postgres Row-Level Security (RLS) as a backstop.** RLS policies on tenant-owned
   tables check `tenant_id = current_setting('app.tenant_id')`. The app sets
   `app.tenant_id` per transaction. Even a query that forgets its `where` clause cannot
   cross tenants. This is defense-in-depth: the app-level scoping is primary, RLS is the
   safety net.

> **Super Admin** is the one role that operates across tenants. It never reads tenant
> business data implicitly — it uses explicit, audited, impersonation (`actAsTenant`)
> that sets the tenant context for the duration of a session and logs every action with
> `impersonated_by`.

See [`RBAC_MATRIX.md`](RBAC_MATRIX.md) for how role + ownership narrow access *within* a
tenant.

---

## 3. Request lifecycle

Every request passes through the same gate before any business logic runs:

```
request
  │
  ├─▶ 1. Authenticate        → session valid? else 401
  ├─▶ 2. Build TenantContext → { tenantId, userId, role } from session (not body)
  ├─▶ 3. Rate limit          → per-IP + per-user token bucket (Redis); else 429
  ├─▶ 4. Validate input      → Zod schema for params/query/body; else 422
  ├─▶ 5. Authorize           → permission policy: role + ownership + tenant; else 403
  ├─▶ 6. Service call         → business logic (tenant-scoped repo)
  ├─▶ 7. Audit (if mutating)  → append audit_log row (who/what/old→new)
  └─▶ 8. Respond              → consistent envelope { data | error }
```

**Intake routes** (`/api/webleads`, `/api/public/*`) have no user session. Step 1
authenticates an **intake credential** instead (Basic auth or API key), and step 2 takes
the tenant from that credential, never from the body. They can only create web leads.
See [`WEBLEADS_COMPATIBILITY.md`](WEBLEADS_COMPATIBILITY.md).

Steps 1–5 are shared middleware/helpers so no route can skip them. A route handler that
reaches the service layer has already been authenticated, tenant-scoped, rate-limited,
validated and authorized.

**Consistent response envelope:**

```ts
// success
{ "data": <payload>, "meta"?: { "nextCursor": string|null, "total"?: number } }
// error
{ "error": { "code": "FORBIDDEN", "message": "…", "details"?: unknown } }
```

Error `code` is a stable enum (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`,
`VALIDATION_ERROR`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`) so the client can branch
without string-matching messages.

---

## 4. Layering (applies to every module)

Business logic never lives in route handlers. Each module is four thin layers:

```
route/handler   → parse request, call service, shape response   (no business rules)
    │
service         → business logic, orchestration, transactions, emits audit + events
    │
repository      → all DB access via tenant-scoped Prisma; the only layer that imports Prisma
    │
validator       → Zod schemas (shared by route input AND service boundary)
policy          → permission checks (pure functions: can(role, action, resource, ctx))
```

Rules enforced by convention + lint:

- A **route** may import services, validators, policies — never the repository or Prisma.
- A **service** may import repositories, other services, policies — never Prisma directly.
- A **repository** is the only place that imports the Prisma client, and only the
  tenant-scoped one (except `auth`/`super-admin`).
- **Policies are pure** and unit-tested exhaustively (they are the security surface).

This keeps the security-critical code (tenant scoping, authorization) small, centralized
and testable, instead of scattered across hundreds of handlers — which is the root cause
of IDOR/tenant-leak bugs.

---

## 5. Domain modules

Each is a self-contained folder with the four layers above. Boundaries follow the
product, not the database:

| Module | Owns | Key collaborators |
|---|---|---|
| `auth` | login, sessions, password reset, MFA | users |
| `tenants` | tenant records, settings, plan/limits | super-admin, billing |
| `users` | team members, roles, lead transfer-on-delete | assignments, audit |
| `students` | student master record + contact data | leads, documents |
| `leads` | pipeline stage, source, potential flag, status history | assignments, followups |
| `assignments` | counselor/telecaller ownership, round-robin | leads, users |
| `followups` | call queue, scheduling, dispositions, overdue/escalation | leads, activities, notifications |
| `activities` | append-only timeline (calls, messages, notes, status changes) | everything |
| `webLeads` | external intake, dedupe, convert-to-student, webhook/API, LeadXP-compatible `/api/webleads` adapter, intake credentials | students, leads, assignments |
| `imports` | CSV/XLSX upload → map → validate → background import | students, leads |
| `exports` | background CSV/XLSX/PDF generation, signed download | reports, students |
| `documents` | folders, files, student document checklist, signed URLs, scan | students, audit |
| `reports` | funnel, source ROI, agent performance, status distribution | leads, followups |
| `notifications` | in-app + push/email reminders and alerts | followups, automations |
| `automations` | rule engine (triggers → conditions → actions); runs recorded with the change, carried out by a job (`AUTOMATION.md`) | leads, followups, notifications |
| `audit` | audit log writer + viewer | all mutating services |
| `billing` | plans, subscriptions, usage metering, invoices | tenants (loosely coupled) |
| `communications` | WhatsApp / email / SMS / click-to-call adapters | activities, students |

The exact folder layout is in [`MODULE_STRUCTURE.md`](MODULE_STRUCTURE.md).

---

## 6. The lead model (why Student and Lead are separate)

The original conflates "a person" with "a lead," which is why duplicate web submissions
become duplicate everything. The rebuild separates them:

- **Student** = the person (name, parent, phones, email, location). One per real human.
- **Lead** = an interest/opportunity for that student (stage, source, assignment,
  follow-ups). A student *can* have more than one lead over time (re-inquiry next intake,
  different country), but the common case is one active lead per student.

Dedupe happens at the **Student** level (by normalized phone, then email). A second web
submission from the same phone attaches to the existing student and either reopens the
existing lead or raises a flag — it does not mint a new person. This is the structural
fix for the junk in the current Web Leads list.

Full state machine in `docs/STUDENT_LIFECYCLE.md` (Phase-later doc); the pipeline stages
and their history table are in [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md).

---

## 7. Status model: one stage + one disposition

The current product has `Status`, `Followup Status` and `Quick Followup Status`
overlapping. The rebuild splits the two distinct concepts cleanly:

- **Pipeline stage** (on the Lead): where the opportunity *is* —
  `NEW → CONTACTED → INTERESTED → FOLLOW_UP_REQUIRED → POTENTIAL → APPLICATION_STARTED →
  DOCUMENTS_PENDING → APPLICATION_SUBMITTED → OFFER_RECEIVED → ADMISSION_CONFIRMED →
  ENROLLED`, plus terminal/negative `NOT_INTERESTED, INVALID, UNREACHABLE, DUPLICATE,
  BLOCKED, LOST` and the parking bucket `LONG_TERM`.
- **Call disposition** (on the Follow-up): what happened on *a call* —
  `SCHEDULED, COMPLETED, NO_ANSWER, BUSY, SWITCHED_OFF, CALL_BACK_LATER, INTERESTED,
  NOT_INTERESTED, AWAITING_FEEDBACK, ESCALATED`.

A disposition can *suggest* a stage change (e.g. `NOT_INTERESTED` → offer to move stage),
but the two are stored separately and never collapsed into one dropdown.

---

## 8. Scale & performance posture

Target: 10k+ leads per tenant now, 1M+ later. Principles baked into the architecture:

- **Cursor pagination** (keyset on `(created_at, id)`), never `OFFSET` on large tables.
- **Server-side search/filter/sort** only; the UI never holds the full dataset.
- **Composite indexes** for the hot query shapes (tenant + status, tenant + counselor +
  next_call, normalized phone). Listed per table in [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md).
- **Virtualized tables** (TanStack) so 50-row pages render regardless of total count.
- **Background jobs** for anything unbounded: imports, exports, bulk reassignment,
  report materialization, reminder sweeps.
- **Redis caching** for dashboard aggregates (short TTL) and rate-limit counters.
- **OpenSearch** is an explicit later option if free-text lead search outgrows Postgres
  trigram indexes — the repository layer isolates search so this swap is local.

Measured at 1,000,000 leads, with what was found and changed, in `SCALABILITY.md`. Two things the load test taught
that shape the design (details there and in `DATABASE_SCHEMA.md`): **row-level security stops Postgres using trigram
(and any other non-leakproof) indexes for the application role**, so student search goes through a tenant-locked
`SECURITY DEFINER` function; and **a count with a `take` is `ORDER BY id`**, so list totals stop at "1,000+" and are
counted newest-first like the list. Dashboard and report answers are kept for a minute (`shared/cache.ts`).

---

## 9. Security posture (summary; full doc later)

Derived from the architecture, enforced by the request lifecycle:

- Tenant from session only; RLS backstop (§2).
- Argon2id password hashing; secure, httpOnly, SameSite cookies; CSRF tokens on mutating
  requests; rotating, single-use, expiring password-reset tokens.
- Zod validation on every input; output encoding by React; CSP + standard security headers.
- Rate limiting (auth endpoints stricter); brute-force lockout with backoff.
- Signed, expiring S3 URLs; upload type/size allow-list; async malware scan before a file
  is marked available.
- No mass assignment: services accept only validated DTOs, never spread request bodies
  into Prisma writes.
- Everything sensitive is audited (§ in request lifecycle; schema in `AUDIT_LOGGING.md`).

Full threat-model-by-category in `docs/SECURITY.md` (later phase).

---

## 9a. Implementation notes (as built, 2026-10-16)

- **Two database roles.** `avn_app` (no ownership, no `BYPASSRLS`) serves all tenant data
  through `withTenant(tenantId, fn)`: one transaction that runs
  `set_config('app.tenant_id', …, true)` and hands `fn` a client extended to inject
  `tenantId` into every tenant-model query (unique-key operations are refused). The owner
  role is used only by `packages/auth` (sessions, login lookups), the platform module, the
  intake-credential lookup and worker system jobs. `avn_app` has no grant on `sessions` or
  `password_reset_tokens`, and only `SELECT, INSERT` on `activities`,
  `lead_status_history` and `audit_logs`, so those are append-only at the database level.
- **Sessions.** Opaque 256-bit token in an httpOnly, SameSite=Lax cookie (Secure on https);
  only its SHA-256 is stored. 7-day absolute and 48-hour idle limits. Each session carries a
  CSRF token that pages receive from the server and send as `x-csrf-token`; mutating API calls
  also need a same-origin `Origin` header.
- **Request gate.** `apps/web/src/lib/api.ts` → `route(options, handler)` implements §3
  steps 1–5 and 8 for every route; services do 6–7 (authorize per action/field, audit in the
  same transaction).
- **CSP.** `proxy.ts` (Next.js 16's middleware) issues a per-request nonce;
  `script-src 'self' 'nonce-…' 'strict-dynamic'`; all pages render per request
  (`connection()` in the root layout) so the nonce is always applied.
- **Login identity.** Users are unique per tenant, so sign-in is workspace (tenant slug) +
  email + password; an empty workspace means a platform (super-admin) account.
- **Observability (Phase 10).** Every API response carries `X-Request-Id`; one JSON log line per event (access log of
  failures and slow requests, unhandled errors with the same id, `render error` from `instrumentation.ts`); the worker
  writes a Redis heartbeat that `/api/health` reports; `/api/metrics` (token-protected, Prometheus text) exposes
  dependency state, job counts and per-instance request counters. `shared/observability.ts` is the single place errors
  are recorded, so an error tracker can be added without touching callers. `RUNBOOK.md` §2.
- **Plans and usage (Phase 10).** `plans.limits` are checked in the services that add users, students, converted web
  leads, imports and documents (`usage/usage.service.ts`); the worker snapshots usage monthly into `usage_counters`.

## 10. Key decisions log

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| D1 | Single Next.js app + worker | Separate API microservices now | Lower ops cost; split only when a module needs independent scaling |
| D2 | Shared-DB row-level tenancy | DB-per-tenant / schema-per-tenant | Simplest migrations at this scale; RLS gives hard isolation |
| D3 | Student ≠ Lead | One "lead" record (original) | Enables real dedupe and multi-inquiry history |
| D4 | Stage + disposition split | One blended status field (original) | Removes the confusing triple-status overlap |
| D5 | Prisma client extension for scoping | Manual `where: {tenantId}` everywhere | One place to get right; lint-forbid the raw client |
| D6 | Policies as pure functions | Inline `if (role === …)` checks | Testable security surface; no scattered checks |
| D7 | BullMQ/Redis for async | In-request processing | Imports/exports/reminders can't block requests at scale |
| D8 | Keep a LeadXP-compatible `/api/webleads` intake | Only the new `/api/public/web-leads` | Sites already posting to LeadXP (eWings) can switch by configuration, with no code change; one service behind both routes |
| D9 | Custom session auth | Auth.js credentials provider | MFA, session listing/revocation, lockout and tenant-scoped identities needed full control |
| D10 | Two Postgres roles (app vs owner) | One role + app-level scoping only | RLS only binds a non-owner role; makes the backstop real and append-only tables enforceable |
| D11 | HTML charts with one validated hue | Recharts | Lighter bundle, full control of accessibility (tooltips on focus, table view), CSP-friendly |
