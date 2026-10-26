# Deployment, Operations & Rollback — aVn CMS

> Status: written for the code in `avn_cms/` as of 2026-10-16. **No hosting target has been
> chosen** (see `BUILD_STATUS.md` → decisions). Everything below is verified locally on
> Windows 11 + Docker; nothing has run on a staging or production host yet.

---

## 1. What runs

| Process | Command (from `avn_cms/`) | Needs |
|---|---|---|
| Web (UI + API) | `pnpm build` once, then `pnpm start` (port 3300) | Postgres, Redis (recommended), SMTP (optional), Cloudflare R2 + ClamAV (for documents) |
| Worker | `pnpm --filter @avn-cms/worker start` | Postgres, **Redis (required)** |
| Migrations | `pnpm db:migrate` | Postgres owner role |

Node.js ≥ 22.12 (developed on 24.14), pnpm 9. The web app is stateless; run as many
instances as needed behind a load balancer. One worker is enough (BullMQ de-duplicates the
repeatable job if more run).

The worker consumes two BullMQ queues: `avn-jobs` (imports, exports, document virus scans and automation runs) and `avn-system`
(overdue sweep every 5 minutes, an automation sweep every 2 minutes that finds uncontacted leads and overdue calls for the time-based rules, queues runs whose hand-over was lost and recovers runs a crash cut off, with finished runs deleted after 90 days (`AUTOMATION.md` §2), expired-file cleanup hourly, and a stuck-jobs sweep every 2 minutes
that marks imports and exports cut off by a worker crash as failed, so people can start over;
see `IMPORT_EXPORT.md` §7; and a document sweep every 2 minutes that re-queues scans that never ran, removes blocked and long-deleted files, and drops abandoned uploads; see `DOCUMENTS.md` §8; and an hourly clean-up of ended sessions and used reset links, `SECURITY.md` §2.1).

Without Redis the web app still works, but rate limits are per process, imports and exports run
inside the web process (development only: a restart cuts them off), and the worker cannot run.
`pnpm --filter @avn-cms/worker sweep:once` runs the overdue, stuck-jobs, documents and automation sweeps once
without Redis (cron fallback; it waits for the automation runs it starts).

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
| `SESSION_TTL_HOURS` | no | Default 168 (7 days); idle sessions end after 48 h. Platform (super-admin) sessions always end after 12 h (4 h idle) |
| `TRUSTED_PROXY_HOPS` | **yes, behind a proxy** | How many proxies in front of the app add an `X-Forwarded-For` entry: `1` for one load balancer or CDN, `2` for a CDN then a load balancer. Default `0` ignores the header. Too low and every caller counts as one address (rate limits become site-wide); too high and a caller can choose their address. `SECURITY.md` §2.2 |
| `MFA_REQUIRED_ROLES` | recommended | Comma-separated roles that must turn on two-step verification, for example `SUPER_ADMIN,TENANT_ADMIN`. Empty: optional for everyone |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | Without SMTP, invites/resets show the admin a one-time link instead; nothing claims an email was sent |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | for documents | Cloudflare R2 (S3 API). All four, in **both the web app and the worker**; without them the documents vault answers "storage is not set up" (503). A half-set group stops the process at start-up. Setup: `DOCUMENTS.md` §9 |
| `R2_ENDPOINT` | no | Overrides `https://<account>.r2.cloudflarestorage.com`. Only for a local S3-compatible server; leave unset on R2 |
| `CLAMAV_HOST`, `CLAMAV_PORT` | for documents | clamd (default port 3310), reachable from the web app and the worker, **on a private network only**. Without it uploaded files stay "checking" and are never released |
| `REPORT_CACHE_SECONDS` | no | Default 60. How long a dashboard or report answer is reused (then ten times as long it is still served while a fresh one is computed). `0` turns the cache off. Shared by all web instances through `REDIS_URL`. `REPORTING.md` §5 |
| `ACCESS_LOG` | no | `errors` (default: requests that failed or were slow), `all`, or `off`. One JSON line per request, never the query string |
| `SLOW_REQUEST_MS` | no | Default 1000. A request slower than this is always logged with `"slow": true` |
| `METRICS_TOKEN` | no | 24+ characters. Turns on `GET /api/metrics` (Prometheus text) for `Authorization: Bearer <token>`. Unset: the endpoint answers 404 |
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

**Migrations on a database that already holds a lot of data.** `scale_indexes` creates four indexes. On a table of
millions of rows a plain `CREATE INDEX` blocks writes while it builds (tens of seconds to minutes). On such a database,
run the same statements by hand first with `CREATE INDEX CONCURRENTLY` (outside a transaction, as the owner role); the
migration's `IF NOT EXISTS` then makes it a no-op. `student_search` only adds a function and is instant. Run `ANALYZE`
after a migration that adds indexes or after any large import. Never edit a migration that has been applied anywhere.

**Sizing and scaling** are in `SCALABILITY.md` §6 (about 70 requests a second per web instance for the load-test mix; 10
database connections per instance; put PgBouncer in front above about 8 instances).

## 5. Health and smoke checks

- `GET /api/health` → `200 {"status":"ok","database":"up","redis":"up","storage":"up","scanner":"up","worker":"up"}`; `503` with
  `"degraded"` when the database or a configured Redis is down. No versions or hostnames.
- `storage` (R2), `scanner` (ClamAV) and `worker` are each `up`, `down` or `not_configured`. They **never** change the
  status or the HTTP code: the rest of the CRM works without documents or the worker, and a load balancer must not pull
  every instance because R2, ClamAV or the worker is down (restarting web servers would not bring them back). Alert on
  any of them being `down` as its own check. Each probe gives up after 1.5 seconds and the storage and scanner answers
  are kept 15 seconds per instance (`DOCUMENTS.md` §10a). The worker answers `up` while it has checked in within the
  last 45 seconds (it writes a heartbeat to Redis every 15); without Redis it is `not_configured`. Files whose virus
  scan did not finish are listed for admins at the top of the Documents page.
- `GET /api/metrics` (only when `METRICS_TOKEN` is set): Prometheus text with `avn_up`, process uptime and memory,
  `avn_dependency_up{dependency=database|redis|storage|scanner|worker}`, `avn_worker_heartbeat_age_seconds`,
  `avn_jobs{state=waiting|active|delayed|failed}`, and per-instance request counters and a duration histogram
  (`avn_http_requests_total`, `avn_http_request_duration_seconds`, labelled by method, resource such as
  `/api/students`, and status class). Scrape every web instance; put the token in the scraper's secret store. It is
  rate limited and holds no tenant names, ids or personal data.
- After each deploy:
  1. `GET /api/health` is 200.
  2. Sign in as an admin; open Dashboard, Leads, Follow-ups, Reports.
  3. Intake: create a credential in **Settings → Website integrations**, then run
     `SMOKE_USERNAME=… SMOKE_SECRET=… pnpm smoke:webleads --url https://<host>` against
     **staging only** (it creates real web-lead rows with test data). Revoke the credential after.

## 6. Logging and monitoring

- Everything is one JSON object per line on stdout (info, warn) or stderr (error), ready for any log collector.
  Every API response carries `X-Request-Id`; the access log (`msg: "request"`: `requestId`, `method`, `path`, `status`,
  `ms`, `slow`, `userId`, `tenantId`) records failures and slow requests by default (`ACCESS_LOG`, `SLOW_REQUEST_MS`),
  and errors are logged with the stack and the same `requestId`; clients only see a short reference id (its first 8
  characters). Pages that fail to render are logged as `render error` with Next's `digest`. Intake requests log channel,
  credential id, status and duration — never the Authorization header, phone numbers or emails. The query string is
  never logged. The alerts to set and what each one means are in `RUNBOOK.md` §2.
- The worker logs each job result and failure as JSON. The stuck-jobs sweep logs one line per
  workspace only when it recovered something (`imports` / `exports` counts): treat that as a sign
  the worker was restarted or killed mid-run.
- Recommended alerts: health check failing; 5xx rate; intake 401 spike (a website with a
  revoked/rotated credential); worker not logging `overdue-sweep` for > 15 minutes; `automation run failed` or `automation run could not be queued` lines (the sweep queues the second kind again, but a steady stream means Redis or the worker is unhealthy).

## 6a. Security checklist before go-live

Details and reasons: `SECURITY.md`. Do these on the real host; none of them can be checked from a laptop.

1. Serve only over **HTTPS** and set `APP_URL` to the `https://` origin (turns on `Secure` cookies, HSTS and
   `upgrade-insecure-requests`). Redirect port 80 to 443 at the proxy.
2. Set **`TRUSTED_PROXY_HOPS`** to the number of proxies in front of the app. Check it: sign in from two networks and
   look at the address in My account → Where you're signed in (it must be each one's real address, not the proxy's).
3. Set **`MFA_REQUIRED_ROLES=SUPER_ADMIN,TENANT_ADMIN`**, and have every admin enrol (and keep their recovery codes).
4. Keep **Postgres, Redis, ClamAV and the worker off the public internet** (private network or security group). The web
   app is the only public process. Postgres accepts the two application roles only.
5. Put `SESSION_SECRET`, `ENCRYPTION_KEY`, both database URLs and the R2 keys in the host's **secret store**, not in the
   image or the repository; the application role (`DATABASE_URL`) must be `avn_app`, never the owner.
6. Run the worker (`avn-system` queue): besides the sweeps it deletes ended sessions and used reset links hourly.
7. Let the proxy terminate TLS 1.2+ only, and **append** to (never trust) the client's `X-Forwarded-For`.
8. Turn on the repository's **private vulnerability reporting**, Dependabot alerts and branch protection (CI and the
   security workflow must pass before merge).
9. Have an **independent penetration test** and a ZAP scan of staging done; fix what they find before real data goes in.
10. Watch: sign-in failures and `auth.locked`/`auth.mfa_locked` audit entries, `automation run failed`, 5xx rate, the
    health check (rate limits fall back to a per-instance floor if Redis is down).

## 7. Backups and recovery

- Take daily logical backups (`pg_dump -Fc`) and keep point-in-time recovery (WAL archiving)
  if the host offers it. Back up `ENCRYPTION_KEY` and `SESSION_SECRET` separately from the
  database (MFA secrets are unreadable without the key).
- Restore drill (do this before go-live and every quarter): `pnpm restore:drill` dumps a database, copies the dump out
  of the server, restores it into a new database and checks row counts, indexes, policies, migrations and the
  application role's access (`RUNBOOK.md` §5.2). Then restore the latest real dump into a new database, point a staging
  web instance at it, and run the smoke checks in §5.
- Redis holds only rate-limit counters and queue state; it can be lost without data loss.
- **Documents are not in the database dump.** They live in the R2 bucket. R2 is durable, but it does not protect against deletion or a bad deploy: keep the bucket private, give the app's token only Object Read & Write on it, and copy the bucket to a second location (for example with `rclone`) on a schedule that matches how much you can afford to lose. A database restore without the bucket leaves records pointing at missing files.

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
