# Deployment, Operations & Rollback — aVn CMS

> Status: written for the code in `avn_cms/` as of 2026-10-16. **No hosting target has been
> chosen** (see `BUILD_STATUS.md` → decisions). Everything below is verified locally on
> Windows 11 + Docker; nothing has run on a staging or production host yet.

---

## 1. What runs

| Process | Command (from `avn_cms/`) | Needs |
|---|---|---|
| Web (UI + API) | `pnpm build` once, then `pnpm start` (port 3300) | Postgres, Redis (recommended), SMTP (optional) |
| Worker | `pnpm --filter @avn-cms/worker start` | Postgres, **Redis (required)** |
| Migrations | `pnpm db:migrate` | Postgres owner role |

Node.js ≥ 22.12 (developed on 24.14), pnpm 9. The web app is stateless; run as many
instances as needed behind a load balancer. One worker is enough (BullMQ de-duplicates the
repeatable job if more run).

The worker consumes two BullMQ queues: `avn-jobs` (imports and exports) and `avn-system`
(overdue sweep every 5 minutes, expired-file cleanup hourly, and a stuck-jobs sweep every 2 minutes
that marks imports and exports cut off by a worker crash as failed, so people can start over;
see `IMPORT_EXPORT.md` §7).

Without Redis the web app still works, but rate limits are per process, imports and exports run
inside the web process (development only: a restart cuts them off), and the worker cannot run.
`pnpm --filter @avn-cms/worker sweep:once` runs the overdue sweep and the stuck-jobs sweep once
without Redis (cron fallback).

## 2. Environment variables

All are read and validated once in `packages/config` (the process exits with a list of
problems if any are invalid). Empty values mean "not set".

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `APP_URL` | yes | Public origin, e.g. `https://cms.example.com`. Used for links in emails, the intake endpoint shown in Settings, and the same-origin check. `https://` turns on Secure cookies |
| `DATABASE_URL` | yes | **Application role** (`avn_app`): row-level security applies |
| `DATABASE_OWNER_URL` | yes | Owner role: migrations, auth lookups, super-admin. Server-only secret |
| `REDIS_URL` | recommended (worker: required) | Rate limits + job queue |
| `SESSION_SECRET` | yes | ≥ 32 random bytes, base64 |
| `ENCRYPTION_KEY` | yes | ≥ 32 random bytes, base64 — encrypts MFA secrets. **Changing it invalidates every enrolled authenticator** |
| `SESSION_TTL_HOURS` | no | Default 168 (7 days); idle sessions end after 48 h |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | Without SMTP, invites/resets show the admin a one-time link instead; nothing claims an email was sent |
| `SEED_PASSWORD` | dev only | Demo seed; the seed refuses to run when `NODE_ENV=production` |

Generate secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Never put secrets in `NEXT_PUBLIC_*` variables (none are used).

## 3. Database setup (once per environment)

1. PostgreSQL 15+ (17 used locally) with the `citext` and `pg_trgm` extensions available.
2. Create two roles: an owner (creates tables; runs migrations) and the application role:
   ```sql
   CREATE ROLE avn_app LOGIN PASSWORD '…' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   ```
   The first migration creates `avn_app` as `NOLOGIN` if it is missing, so grants never fail;
   then `ALTER ROLE avn_app LOGIN PASSWORD '…'`.
3. `pnpm db:migrate` (uses `DATABASE_OWNER_URL`). Migrations are additive SQL in
   `packages/db/prisma/migrations`; they include the RLS policies and grants.
4. **Do not run `pnpm db:seed` in production** — it creates demo tenants and test users.
   Create the first agency from the platform screen (super admin) or with a one-off script.

The first super admin:

```bash
pnpm admin:create-superadmin --email ops@example.com --name "Ops Admin"
```

It prints a one-time link (72 hours) to set the password; sign in with an empty workspace
field. The super admin then creates agencies on the Platform screen.

## 4. Build and release

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint && pnpm typecheck && pnpm test     # test needs a Postgres with the *_test database
pnpm build
pnpm db:migrate                              # before switching traffic
pnpm start                                   # or your process manager / container
```

Release order: **migrate → start new web instances → health check → switch traffic → restart
worker.** Migrations are written to be backwards-compatible with the previous release (add,
never rename or drop in the same release).

## 5. Health and smoke checks

- `GET /api/health` → `200 {"status":"ok","database":"up","redis":"up"}`; `503` with
  `"degraded"` when the database or a configured Redis is down. No versions or hostnames.
- After each deploy:
  1. `GET /api/health` is 200.
  2. Sign in as an admin; open Dashboard, Leads, Follow-ups, Reports.
  3. Intake: create a credential in **Settings → Website integrations**, then run
     `SMOKE_USERNAME=… SMOKE_SECRET=… pnpm smoke:webleads --url https://<host>` against
     **staging only** (it creates real web-lead rows with test data). Revoke the credential after.

## 6. Logging and monitoring

- Request errors are logged as one JSON line (`level`, `msg`, `requestId`, `error`); clients only
  see a short reference id. Intake requests log channel, credential id, status and duration —
  never the Authorization header, phone numbers or emails.
- The worker logs each job result and failure as JSON. The stuck-jobs sweep logs one line per
  workspace only when it recovered something (`imports` / `exports` counts): treat that as a sign
  the worker was restarted or killed mid-run.
- Recommended alerts: health check failing; 5xx rate; intake 401 spike (a website with a
  revoked/rotated credential); worker not logging `overdue-sweep` for > 15 minutes.

## 7. Backups and recovery

- Take daily logical backups (`pg_dump -Fc`) and keep point-in-time recovery (WAL archiving)
  if the host offers it. Back up `ENCRYPTION_KEY` and `SESSION_SECRET` separately from the
  database (MFA secrets are unreadable without the key).
- Restore drill (do this before go-live): restore the latest dump into a new database, point a
  staging web instance at it, run the smoke checks in §5.
- Redis holds only rate-limit counters and queue state; it can be lost without data loss.

## 7a. Data safety rules

- Never run `prisma migrate reset`, `db:reset:test` or `DROP SCHEMA` against anything but a
  `*_test` or disposable local database (`resetTestDatabase` refuses names not ending in `_test`).
- Students, leads and users are soft-deleted; audit, activities and stage history are
  append-only for the application role (enforced by grants).

## 8. Rollback

| Situation | Action |
|---|---|
| Bad web release, no migration in it | Redeploy the previous build; no data step |
| Bad web release with an additive migration | Redeploy the previous build; leave the new columns/tables (old code ignores them) |
| A migration itself fails | Prisma marks it failed; fix forward, or restore the pre-release backup if data was changed. Never edit an applied migration |
| Data damage | Point-in-time restore to just before the release into a new database; swap `DATABASE_URL`/`DATABASE_OWNER_URL`; re-run smoke checks |
| A website sends bad data | Revoke its credential in Settings → Website integrations (immediate 401); mark rows Spam/Rejected |
| Switching a website from LeadXP to aVn CMS (later step) | Revert its `LEAD_API_URL` and credentials (`WEBLEADS_COMPATIBILITY.md` §7) |

## 9. Platform notes

- Turbopack builds; the app uses Node APIs (Argon2 native module, `pg`), so it needs a Node.js
  server runtime, not an edge runtime.
- Every page is rendered per request (needed for the CSP nonce), so static hosting is not
  possible.
- Behind a proxy, make sure `X-Forwarded-For` is set by the proxy (rate limits and audit IPs
  use its first entry) and strip any client-supplied value at the edge.
