# Build Status — aVn CMS

> Live record. A module is **Verified** only when its behaviour runs and its checks pass.
> Code: `avn_cms/`. Last updated: 2026-10-16.

**Overall status: FOUNDATION IMPLEMENTED — CORE MODULES INCOMPLETE**

Phases 1–5 of `DEVELOPMENT_PHASES.md` are implemented and verified locally (with the gaps
listed below); Phases 6–8 (import/export, documents, automation) are not started, so the
documented scope is not complete and this is not yet ready for staging validation.

## Phases

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Planning docs | Done | `docs/*.md` |
| Discovery | Audit + requirements | Done | `PROJECT_AUDIT.md`, `REQUIREMENTS.md` |
| 1 | Foundation: schema, RLS, auth, tenants, RBAC, shell | **Verified** | tenancy/auth integration suites; RBAC matrix unit test (every cell); e2e sign-in, CSP, RBAC |
| 2 | Students/leads workspace & CRUD | **Verified** (one gap) | leads integration suite; e2e lead journey. Gap: 100k-row load test not run; CSV template endpoint not built (belongs with Phase 6) |
| 3 | Assignments + follow-up engine + timeline | **Verified** | follow-up integration suite (queue, dispositions, escalation sweep); e2e log-call flow |
| 4 | Dashboards & reports | **Verified** (one gap) | reports reconciliation suite; e2e. Gap: no Redis caching / materialisation yet (not needed at current volumes) |
| 5 | Web leads + LeadXP-compatible `/api/webleads` | **Verified locally** | 12 contract tests (both eWings payload shapes), HTTP smoke script 7/7, e2e intake → convert |
| 6 | Import / export | Not started | |
| 7 | Documents vault | Not started (tables exist) | |
| 8 | Automation rules | Not started (tables exist). Built-in: round-robin assignment, overdue escalation | |
| 9 | Security hardening | Partly | See security section |
| 10 | Production readiness | Partly | `DEPLOYMENT.md`, health check, smoke script; no host chosen |

## Modules

| Module | State | Notes |
|---|---|---|
| Auth (login, sessions, lockout, reset, MFA/TOTP, sessions list, sign out others) | Verified | Workspace + email + password; Argon2id; DB sessions; CSRF token per session |
| Tenancy (scoped client + RLS on `avn_app`) | Verified | Raw SQL as `avn_app` can't read/write another tenant, sessions, or rewrite audit |
| RBAC (37 actions × 4 roles) | Verified | Pure policy + per-field checks; 404 for others' records |
| Students/leads (create, dedupe, search, filters, views, keyset pagination, stage, potential/HOT, assignment, notes, bulk, soft delete) | Verified | |
| Follow-ups (queue buckets, schedule, reschedule, disposition logging, suggested stage, next call) | Verified | |
| Activity timeline, stage history, audit log + viewer | Verified | Append-only enforced by grants |
| Worker (BullMQ repeatable overdue sweep + escalation notifications) | Verified (logic) | Sweep covered by integration test; the BullMQ loop itself was not run against Redis in a test |
| Web leads inbox (status, flags, convert/attach, spam/reject) | Verified | |
| Intake credentials (create/rotate with 24 h overlap/revoke) | Verified | |
| Dashboards (role-aware) + Reports (funnel, sources, team, stage, calls) | Verified | Charts: one validated hue, HTML bars/columns, table view |
| Users (invite, role, disable, reset, transfer-on-delete, delete) | Verified | Last-admin and self-change guards |
| Settings (timezone, round-robin, uncontacted minutes, lead sources) | Verified (UI + API) | `uncontactedMinutes` is stored but only used once automations exist |
| Platform (agencies, suspend, audited impersonation, metrics) | Verified | |
| Notifications UI | Not built | Escalations write `notifications` rows; no bell/inbox yet |

## Tests (actual results, 2026-10-16, local Windows 11, Node 24.14, Postgres 17)

| Suite | Command | Result |
|---|---|---|
| Lint (incl. architecture import boundaries) | `pnpm lint` | pass, 0 warnings |
| Format | `pnpm format:check` | pass |
| Typecheck (6 packages) | `pnpm typecheck` | pass |
| Unit | `pnpm test:unit` | **170 passed** (RBAC matrix, TOTP RFC 6238 vectors, crypto, phone, cursors, intake normaliser, tenant-model list) |
| Integration (real Postgres, RLS) | `pnpm test:integration` | **57 passed** (tenancy, auth, leads, follow-ups, web-leads contract, reports, users/platform, health) |
| End-to-end (production build, Chromium, axe WCAG A/AA serious+critical) | `pnpm test:e2e` | **15 passed** |
| Production build | `pnpm build` | pass (all pages dynamic for CSP nonces) |
| HTTP smoke, LeadXP-compatible intake | `pnpm smoke:webleads --url http://localhost:3300 --tenant demo` | 7/7 (246 ms first request) |

Not run: load test at 100k / 1M leads; WebKit/Firefox e2e; tests against a real staging host.

## Security status

Done: tenant from session only; scoped client + RLS backstop; app DB role without BYPASSRLS
and without access to sessions; append-only audit/timeline grants; Argon2id; lockout with
backoff; generic login errors with timing equalisation; single-use expiring reset tokens;
TOTP MFA (secret AES-256-GCM at rest; re-enrolment can't drop an active factor); CSRF token +
same-origin check on cookie mutations; per-user and per-IP rate limits (Redis); strict CSP with
per-request nonce; security headers; Zod on every input; no mass assignment (tested);
secrets never logged; intake secrets hashed and shown once.

Open: dependency/secret scanning in CI (no CI yet); penetration-test checklist (Phase 9);
MFA recovery codes; per-tenant `X-Forwarded-For` trust configuration.

## Known issues

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
- Counselors see an empty Web leads inbox: "routed to them" needs a routing rule (Phase 8).
- Source ROI shows conversion only: ad spend isn't recorded.

## External dependencies / not in scope by decision

- eWings: **compatibility only** (owner decision). `POST /api/webleads` accepts both eWings
  payloads; no eWings code was changed; switching eWings is a later configuration step.
- Outbound forwarding to LeadXP: not built; LeadXP's response contract is unverified.
- Telephony (click-to-call is `tel:` links only), WhatsApp, SMS: provider decisions needed.
- AI providers/agents and Payload CMS: not in the documented scope (`PROJECT_AUDIT.md` §4).

## Decisions requiring approval

1. **Repository:** `main` is pushed to https://github.com/satishvarma2733-byte/avn_teli_cms
   (2026-10-16, repo-local identity `opsewings`). No CI is configured yet.
2. **Hosting target** for staging and production (Node server + Postgres + Redis).
3. **Reset the local dev database** to load the corrected seed (destructive, local only).
4. Next phase order: Import/Export (6) → Documents (7, needs S3/MinIO) → Automation (8).

## Files

Code: `avn_cms/` — 190 TypeScript/TSX/SQL/CSS source files (~15.8k lines) across
`apps/web`, `apps/worker`, `packages/{config,db,auth,core}`, `tests/`, `scripts/`.
Docs created: `PROJECT_AUDIT.md`, `REQUIREMENTS.md`, `BUILD_STATUS.md`, `DEPLOYMENT.md`.
Docs updated: `README.md`, `ARCHITECTURE.md`, `MODULE_STRUCTURE.md`, `DEVELOPMENT_PHASES.md`,
`WEBLEADS_COMPATIBILITY.md`.
