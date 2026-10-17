# aVn CMS — Educational CRM/CMS (Rebuild)

A modern, multi-tenant Educational CRM/CMS SaaS for overseas-education consultancies
(MBBS-abroad and similar). It captures student leads from ads, websites, CSV imports
and manual entry; routes them to counselors and telecallers; drives a disciplined
follow-up call queue; tracks the full lead-to-enrollment lifecycle; and gives agency
owners real reporting on conversion, source ROI and team performance.

This repository is a ground-up rebuild of the existing `leadxp.aikosoft.ai` product.
It keeps the parts of the original that work (the follow-up call queue, inline
reassignment, source tagging, the web-leads inbox) and fixes the gaps found in review
(no activity timeline, no telephony, no WhatsApp, thin reporting, leaking data quality,
no bulk actions, no real multi-tenant/RBAC hardening).

> **Status:** Phases 1–9 (foundation, students and leads, follow-ups, dashboards and reports, web leads with LeadXP-compatible intake, import and export, documents vault, automation rules, security hardening) are built and verified locally; the documents vault was tested on MinIO and ClamAV, not yet on a real Cloudflare R2 bucket, and the security review was internal (an independent test is still to do). Phase 10 (production readiness) is partly done. Code lives in [`avn_cms/`](avn_cms/). Live status and test results: [`docs/BUILD_STATUS.md`](docs/BUILD_STATUS.md).

---

## Why this rebuild exists

The original is a capable internal admin panel but has structural limits:

| Area | Original behaviour | What the rebuild does |
|---|---|---|
| Lead history | Single comment field, no history | Append-only **activity timeline** per lead |
| Calling | Copy-paste phone numbers | **Click-to-call** + auto-logged call disposition |
| Messaging | None in the app | **WhatsApp Business** templates + shared inbox |
| Reporting | Record list + duplicated block | **Funnel, source-ROI, conversion-by-agent** |
| Data quality | Duplicate web leads, junk emails | **Dedupe + intake validation** |
| Status model | `Status` and `Followup Status` overlap | One **pipeline stage** + one **disposition** |
| Admin ops | Per-row dropdowns only | **Bulk select → reassign / status / delete** |
| Tenancy / RBAC | Assumed, UI-level | **Enforced server-side on every query** |

Full reasoning is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the roadmap.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js (App Router) + React + TypeScript** | One deployable; API routes + server actions |
| Styling | **Tailwind CSS 4 + Radix primitives** | Own design tokens (light/dark) in `globals.css`; shadcn-style components in `apps/web/src/components/ui` |
| Database | **PostgreSQL** | UUID PKs, row-level tenant scoping |
| ORM | **Prisma** | Typed access; migrations in repo |
| Validation | **Zod** | Shared schemas for API + forms |
| Tables | **TanStack Virtual** | Window-virtualized rows; server-driven keyset pagination |
| Forms | **Controlled React forms** | Server-side Zod validation; field errors returned by the API |
| Charts | **Accessible HTML bars/columns** | One validated data hue, tooltips, table view (no chart library) |
| Cache / queue | **Redis + BullMQ** | Imports, exports, automations, reminders |
| File storage | **S3-compatible** | Signed URLs, type/size rules, virus scan |
| Auth | **Custom (`packages/auth`)** | DB sessions, Argon2id, lockout, reset tokens, TOTP MFA, CSRF token |
| Testing | **Vitest (unit) + Playwright (e2e)** | RBAC and tenant-isolation suites are mandatory |

Rationale and the "separate Node service later" trigger are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Repository map

```
leadxp-rebuild/
├── README.md                     ← you are here
├── docs/
│   ├── ARCHITECTURE.md           ← system design, multi-tenancy, layering
│   ├── DATABASE_SCHEMA.md        ← Postgres/Prisma schema + indexes
│   ├── RBAC_MATRIX.md            ← roles × resources × actions
│   ├── PAGES_AND_ROUTES.md       ← page tree + API route list
│   ├── MODULE_STRUCTURE.md       ← folder/module layout + conventions
│   ├── DEVELOPMENT_PHASES.md     ← the 10-phase build plan (with status)
│   ├── WEBLEADS_COMPATIBILITY.md ← LeadXP-compatible /api/webleads intake
│   ├── PROJECT_AUDIT.md          ← discovery: what existed, conflicts, decisions
│   ├── REQUIREMENTS.md           ← requirements traced to docs and phases
│   ├── BUILD_STATUS.md           ← live build status + actual test results
│   └── DEPLOYMENT.md             ← environments, release, health, backups, rollback
└── avn_cms/                      ← the application (pnpm workspace)
    ├── apps/web                  Next.js 16: UI + API route handlers
    ├── apps/worker               BullMQ worker: overdue sweep + escalation
    ├── packages/config           environment validation (the only process.env reader)
    ├── packages/db               Prisma schema, SQL migrations (RLS), seed, tenant-scoped client
    ├── packages/auth             sessions, Argon2id, lockout, reset, TOTP MFA
    ├── packages/core             domain services, RBAC policy, Zod schemas
    ├── tests/                    integration (real Postgres), e2e (Playwright + axe), fixtures
    └── scripts/                  intake smoke test, super-admin bootstrap
```

Later phases add the remaining spec docs (`FEATURES.md`,
`SECURITY.md`, `TEST_PLAN.md`, …) as their modules are built.

---

## Getting started (local)

Prerequisites: Node.js 22.12+ (developed on 24), pnpm 9, Docker Desktop.

```bash
cd avn_cms
pnpm install
cp .env.example .env            # then fill SESSION_SECRET and ENCRYPTION_KEY (command in the file)
pnpm stack:up                   # Postgres 17 :55450, Redis :16390, Mailpit :51125 / :58125
pnpm db:migrate
pnpm db:seed                    # TEST DATA: tenants "demo" and "other", one user per role
pnpm dev                        # http://localhost:3300
pnpm dev:worker                 # needs Redis: runs imports/exports queued while REDIS_URL is set (leave it empty to run them inside pnpm dev) and the sweeps
```

Sign in with workspace `demo` and `admin@demo.test` (or `counselor1@demo.test`,
`telecaller1@demo.test`, …) using the `SEED_PASSWORD` from `.env`. The platform admin is
`superadmin@avn-cms.test` with an empty workspace. Invite and reset emails land in Mailpit at
http://127.0.0.1:58125.

Quality gates:

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test                       # unit + integration (avn_cms_test database; the queue test needs the Redis from stack:up)
pnpm test:e2e                   # production build + Playwright + axe accessibility checks
pnpm smoke:webleads --url http://localhost:3300 --tenant demo
```

Deployment, backups and rollback: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Non-negotiables

1. **Tenant isolation is server-side.** `tenant_id` is derived from the authenticated
   session, never trusted from the client. Every data query is scoped to it.
2. **RBAC is checked at the API/service boundary**, not only hidden in the UI.
3. **No endpoint returns a record the caller is not entitled to** (tenant + role +
   ownership). IDOR/BOLA tests block the merge.
4. **Every state change is auditable** — who, when, from→to, note.
5. **Never fetch all leads at once.** Cursor pagination + server filtering everywhere.

---

## License / ownership

Private. Internal to eWings / aikosoft.ai. Not for redistribution.
