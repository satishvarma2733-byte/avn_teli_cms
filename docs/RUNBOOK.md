# Runbook — aVn CMS

> For whoever is on call. What to watch, what each alarm means, and what to do about it. It assumes the layout in
> `DEPLOYMENT.md` (web instances, one worker, Postgres, Redis, R2, ClamAV). Commands run from `avn_cms/`.
> Nothing here has run against a production host yet; the procedures were exercised locally and in the load and
> restore drills (`SCALABILITY.md`, §5 below).

## 1. First five minutes

1. **Is it up?** `GET /api/health`. `200 {"status":"ok"}` means the database and Redis answer. `503 "degraded"` means one
   of them does not: go to §4.1 or §4.2.
2. **What does the field say?** `database`, `redis`, `storage`, `scanner`, `worker` are each `up`, `down` or
   `not_configured`. Only database and Redis change the status code; the others are separate alarms.
3. **Find the request.** Every response carries `X-Request-Id`; an error page shows the first 8 characters. Search the
   logs for it: one line per event, JSON, with `requestId`.
4. **Is it only slow?** Look at `avn_http_request_duration_seconds` in the metrics, or filter logs for `"slow":true`
   (§2.2). Slow is usually the database (§4.7) or the cache being cold after a deploy.
5. **Changed recently?** Deploy, migration, a new import, a website that started posting leads, a plan change.

## 2. Watching it

### 2.1 Signals

| Signal | Where | Healthy |
|---|---|---|
| Health | `GET /api/health` (probe every 30 s from outside) | 200, `database: up` |
| Metrics | `GET /api/metrics` with `Authorization: Bearer $METRICS_TOKEN` (off until `METRICS_TOKEN` is set, 24+ characters). Scrape **every** web instance | see §2.3 |
| Logs | stdout/stderr of web and worker, one JSON object per line: `level`, `msg`, and context | few `error` lines |
| Worker heartbeat | `worker` in health; `avn_worker_heartbeat_age_seconds` | `up`, age < 45 s |
| Job queue | `avn_jobs{state=…}` | `waiting` small, `failed` not growing |
| Audit log | Settings → Audit log (`auth.locked`, `auth.mfa_locked`, `intake_credential.*`, `platform.*`) | |

### 2.2 Log lines you will see

| `msg` | `level` | Meaning and action |
|---|---|---|
| `request` | info / warn / error | The access log. With `ACCESS_LOG=errors` (default) only status ≥ 400 and slow requests (`SLOW_REQUEST_MS`, default 1000) are logged; `all` logs every request, `off` none. Fields: `requestId`, `method`, `path` (no query string), `status`, `ms`, `slow`, `userId`, `tenantId` |
| `unhandled` | error | A request failed with a bug or a dependency error; the stack is in `error`. Match `requestId` to the user's reference |
| `tenant scope violation` | error | Code tried to touch a record outside the workspace and was stopped. **Never ignore**: it is a bug that the isolation layer caught (`SECURITY.md` §2.3) |
| `render error` | error | A page failed to render (`digest` matches the id on the error page) |
| `job done` / `job failed` | info / error | Worker results; `queue`, `job`, `id`. See §4.5 |
| `automation run failed` / `could not be queued` | error | `AUTOMATION.md` §2. A steady stream means Redis or the worker is unhealthy |
| `worker heartbeat failed` | error | The worker cannot reach Redis |
| `background refresh of a cached answer failed` | error | A dashboard/report recompute failed; people keep seeing the old answer for up to ten minutes. Usually the database |
| intake lines (channel, credential id, status, duration) | info | Never the Authorization header, phone numbers or emails |

### 2.3 Alerts to set

| Alert | Condition | Severity | Go to |
|---|---|---|---|
| Down | health non-200 for 2 minutes | page | §4.1 |
| Redis | `avn_dependency_up{dependency="redis"} == 0` | page | §4.2 |
| Worker | `worker: down` or heartbeat age > 90 s for 5 minutes | page | §4.3 |
| Errors | 5xx ratio > 2 % for 5 minutes (`avn_http_requests_total{status="5xx"}`), or any `tenant scope violation` | page | §4.8 |
| Slow | p95 above 2 s for 10 minutes (from the duration histogram) | ticket | §4.7 |
| Jobs | `avn_jobs{state="failed"}` rising, or `waiting` > 100 for 15 minutes | ticket | §4.5 |
| Documents | `dependency="storage"` or `"scanner"` == 0 for 10 minutes | ticket | §4.6 |
| Sweeps | no `overdue-sweep` job done for 15 minutes | ticket | §4.3 |
| Intake | spike of 401 on `/api/webleads` (a website with a revoked credential), or of 429 | ticket | §4.9 |
| Security | many `auth.locked` rows for one workspace or address | ticket | `SECURITY.md` §6 |
| Disk | database volume > 80 % | ticket | §4.10 |
| Backups | last successful backup older than 26 hours; last restore drill older than 90 days | ticket | §5 |

## 3. Routine work

| Task | How |
|---|---|
| Deploy | `DEPLOYMENT.md` §4: migrate → new web instances → health → switch traffic → restart the worker |
| Roll back | `DEPLOYMENT.md` §8 |
| Add an agency | Platform console → New agency; send the admin the invitation link if SMTP is off |
| Pause an agency | Platform console → Pause. Its sessions stop at the next request; data is kept |
| Change an agency's plan | Platform console → Change plan (refused when it is over the new limits; lower the use first) |
| First super admin | `pnpm admin:create-superadmin --email … --name …`; it prints a one-time link |
| Rotate an intake credential | Settings → Website integrations → Rotate (24-hour overlap while the website is updated) |
| Rotate `SESSION_SECRET` / `ENCRYPTION_KEY` | Everyone signs in again; with `ENCRYPTION_KEY`, everyone with two-step verification re-enrols (`SECURITY.md` §6) |
| Scale web | Add instances behind the load balancer; they are stateless. Keep `TRUSTED_PROXY_HOPS` correct |
| Scale the worker | One is enough; a second is safe (BullMQ de-duplicates the repeating jobs) |
| Run the sweeps without Redis | `pnpm --filter @avn-cms/worker sweep:once` (cron fallback) |
| Refresh monthly usage now | The worker does it hourly; `sweep:once` also runs it |

## 4. Incidents

### 4.1 Health is 503 and `database` is down

1. Can the web host reach Postgres (network, security group, credentials changed)? Is the server out of connections
   (`max_connections`; each web instance holds up to 10, the owner client 5)? Is it in recovery or out of disk (§4.10)?
2. If the primary is lost, restore (§5.3) or fail over, then point `DATABASE_URL` and `DATABASE_OWNER_URL` at it and restart.
3. After it returns, check the worker (§4.3) and run `sweep:once`.

### 4.2 Redis is down

The app keeps working: rate limits fall back to a per-instance counter, the report cache falls back to per-instance
memory, imports/exports/scans/automation runs **cannot be queued** (a person sees "could not be started, try again")
and the worker cannot run. Health reports `degraded`. Restore Redis; nothing needs replaying: queued work lives in
Redis, but every job has a database row that the sweeps re-queue (`failStuckJobs`, the automation sweep, the document
sweep). Redis may be lost entirely without data loss (`DEPLOYMENT.md` §7).

### 4.3 The worker is down or sweeps stopped

Symptoms: `worker: down`, no `job done` lines, calls not turning overdue, imports stuck at "queued". Restart the worker
and read its first lines for the error (usually `REDIS_URL is required`, a missing `R2_*` group, or a bad database URL).
When it starts it schedules the repeating jobs itself. Imports and exports cut off mid-run are marked failed by the
stuck-jobs sweep within a few minutes so people can start over (`IMPORT_EXPORT.md` §7).

### 4.4 Sign-in problems

- *Everyone is locked out behind the load balancer:* `TRUSTED_PROXY_HOPS` is 0, so all callers share one address and
  the sign-in limit (10 a minute) applies to the whole site. Set it to the number of proxies and restart.
- *One person is locked:* the lock ends by itself; an admin can reset their password, which also signs them out
  everywhere.
- *Cookies not stored:* `APP_URL` must be the exact `https://` origin people use.
- *Lost authenticator and recovery codes:* there is no self-service path (`IMPROVEMENT_ROADMAP.md` P0 #7). After
  checking the person's identity, an operator with the owner database role clears the second factor so they can enrol
  again, and records why:
  ```sql
  -- psql as the owner role; <id> is the user's id. Check the row first.
  UPDATE users SET mfa_secret = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL,
                   mfa_failed_count = 0, mfa_locked_until = NULL WHERE id = '<id>';
  DELETE FROM mfa_recovery_codes WHERE user_id = '<id>';
  ```
  If their role is in `MFA_REQUIRED_ROLES` they must enrol again at the next sign-in. Revoke their sessions
  (`DELETE FROM sessions WHERE user_id = '<id>'`) and add a note to the ticket.

### 4.5 Jobs: failed, stuck or piling up

`avn_jobs{state="failed"}` and the worker's `job failed` lines name the job. Imports and exports show their error in the
app (Imports / Exports pages). Documents stuck in "checking" are listed at the top of the Documents page for admins and
can be scanned again. A backlog with a healthy worker usually means one very large import; the queue drains by itself.
Failed jobs are kept 30 days. A job that fails twice the same way is a bug: capture the `job` id and the log line.

### 4.6 Documents unavailable

`storage` down: check R2 credentials/endpoint, bucket name, the token's permissions, Cloudflare status. `scanner` down:
is `clamd` running and reachable on `CLAMAV_HOST:CLAMAV_PORT`? Uploads that cannot be scanned stay unavailable (never
served unscanned) and are re-queued by the document sweep once the scanner is back. Neither affects the rest of the CRM.

### 4.7 Slow

1. Which route? Group `request` log lines by `path` where `slow: true`, or look at the histogram by `resource`.
2. Dashboard or reports slow after a deploy: the cache is cold; the first view of each agency pays the compute time
   (`SCALABILITY.md` §5), later views are served from the cache. Redis down makes it per-instance.
3. Lead list or search slow for one agency: has it grown past the sizes in `SCALABILITY.md`? Run
   `EXPLAIN (ANALYZE, BUFFERS)` on the statement from `pg_stat_statements`. A search that falls back to a scan means
   `search_student_ids` is missing or the migration `student_search` did not run.
4. Everything slow: database CPU/IO, connection saturation, a long-running query (`pg_stat_activity`), a missing
   `ANALYZE` after a big import (`ANALYZE students, leads;`).
5. Cancel a runaway query with `SELECT pg_cancel_backend(pid)`. The statement timeout is 30 s for the app already.

### 4.8 5xx errors or a tenant-scope violation

Find `unhandled` lines by `requestId`. A single failing route after a deploy → roll back (`DEPLOYMENT.md` §8). A
`tenant scope violation` is a security-relevant bug: keep the log lines, roll back if it came with a deploy, and follow
`SECURITY.md` §6 ("A workspace is compromised") if data may have crossed.

### 4.9 Intake spike or abuse

401s: a site is posting with a revoked/rotated credential: tell the site owner. A flood: the endpoint is rate limited
per credential and per address; revoke the credential (Settings → Website integrations) to stop it at once, mark the
junk rows Spam, and check that `TRUSTED_PROXY_HOPS` is right so the limit is per caller. `WEBLEADS_COMPATIBILITY.md` §7
has the rollback to the old endpoint.

### 4.10 Disk full or growing fast

Largest tables are `activities`, `lead_status_history`, `audit_logs`, `follow_ups`, `leads`, `students` and the indexes on
them (about 4 GB in all at 1.2 million leads — 1.5 GB of tables and 2.4 GB of indexes — `SCALABILITY.md` §3). Check for a runaway import, then
`VACUUM (VERBOSE)` and table bloat. Add disk; do not delete audit rows by hand.

## 5. Backups and the restore drill

### 5.1 What is backed up

| Data | Where | How |
|---|---|---|
| Database | Postgres | Daily `pg_dump -Fc` (kept off the database host) plus point-in-time recovery if the host offers WAL archiving |
| Documents | R2 bucket | Copy the bucket to a second location on a schedule (for example `rclone`); R2 does not protect against deletion |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Secret store | Back up separately: without the key, two-step verification secrets cannot be read |
| Redis | — | Not needed |

### 5.2 The drill

`pnpm restore:drill` takes a custom-format dump of a database, copies it out of the server as an off-site copy would
be, restores it into a **new** database (`<name>_restore_drill`, dropped afterwards; it refuses to touch anything
else), and checks that the copy is the same and still works as the application uses it:

- every table has the same number of rows;
- the same number of indexes, constraints, row-level-security policies, functions, extensions and enum types;
- the same migration history;
- the application role reads its own workspace's rows through row-level security, sees nothing without a workspace,
  and still cannot read password hashes.

Run it against production-like data before go-live and every quarter, against a restored backup rather than the live
database where possible (`--container`, `--db`, `--owner-url`, `--app-url`). Exit code 0 means the backup is
restorable. Last result (2026-10-17, the 1,000,000-lead load database, local Docker Postgres 17):

| | |
|---|---|
| Data | 30 tables, 9,937,038 rows, 3.9 GB on disk |
| Backup (`pg_dump -Fc -Z 6`, copied out of the container) | **46.5 s, 555 MB** |
| Restore (`pg_restore -j 4`) into a new database | **151.8 s** |
| Checks | all 6 passed: same rows in all 30 tables; same 100 indexes, 58 constraints, 24 policies on 24 row-level-security tables, 83 functions, 4 extensions, 19 enum types; same 9 migrations (last `student_search`); the application role reads its workspace's 1,000,508 leads through row-level security, sees nothing without a workspace, and cannot read password hashes |

So a restore of a million-lead database takes about 2½ minutes of machine time plus whatever it takes to copy the
backup, on this laptop; expect the real figure to depend on the host's disks and network. The drill does not test the
document bucket (copy it separately, §5.1) or point-in-time recovery (use the host's WAL tooling).

### 5.3 Restoring for real

1. Create a new database and the two roles (`DEPLOYMENT.md` §3).
2. `pg_restore -d <new> -j 4 --exit-on-error backup.dump` as the owner role. For point-in-time recovery follow the
   host's procedure to just before the incident.
3. Point a **staging** web instance at it and run the smoke checks (`DEPLOYMENT.md` §5): sign in, dashboard, leads,
   reports, an intake test.
4. Restore the document bucket copy if files were lost; a database restore without it leaves records that point at
   missing files.
5. Swap `DATABASE_URL` / `DATABASE_OWNER_URL` on production, restart web and worker, run `ANALYZE`, watch §2.3.
6. Write down the window of data lost and tell the affected agencies.

## 6. Data requests

*Export an agency's data:* admins can export leads and web leads (CSV/XLSX) from the app; a full dump for one agency is
a `pg_dump` filtered by `tenant_id` run by an operator. *Delete a person's data on request:* delete the student (soft
delete, removes them from every view); permanent erasure of a student's rows and files is an operator task not yet
automated — keep the audit rows that record the request (`IMPROVEMENT_ROADMAP.md`).

## 7. Contacts

Fill in before go-live: on-call rota, hosting support, Cloudflare account owner, SMTP provider, the product owner, the
person who may approve a rollback, and where the secret store and the backups live.
