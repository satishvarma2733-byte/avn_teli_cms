# Scalability — aVn CMS

> How the product behaves with a million leads, what the load test found and fixed, how to size a deployment, and how
> plans and usage metering work. Code: `avn_cms/scripts/loadtest/` (seed, runner, probe), `avn_cms/scripts/restore-drill.ts`,
> `packages/core/src/shared/cache.ts`, `packages/core/src/usage/`. Raw results: `avn_cms/load-results/`.
>
> **Read the numbers as a laptop's.** The load generator, one to three web servers and Postgres all ran on one Windows
> machine (24 logical CPUs, 11.5 GB for Docker) talking over loopback. That makes network time zero and CPU contention
> real. A production host will differ; re-run on the real one (§9). Nothing here was measured on a host.

## 1. Summary

| Question | Answer |
|---|---|
| Target | One agency with **1,000,000 leads** and **150 staff** working at once, plus websites posting enquiries |
| Result at a realistic pace (one action per person about every 5 s: 29 requests a second) | **0 errors; p50 48 ms, p95 211 ms, p99 428 ms**; every kind of request within its target (§5.1) |
| Result at 7× that pace (one action every 0.7 s: 72 requests a second, one web server) | 0 errors; p50 1.2 s, p95 2.6 s: **one Node server is CPU-bound at about 70 requests a second** (§5.2) |
| Scaling out | Three web servers on the same machine: **117 requests a second (1.6×), p50 454 ms, p95 1.4 s, 0 errors** — the limit moved to the machine itself (§5.2) |
| Biggest wins from the test | Search 3.5–6 s → 15–200 ms; state filter 1.4 s → 27 ms; list totals 1 s → ≤ 190 ms; dashboard 21 s (timed out) → 2.5 s cold and instant cached (§4) |
| Open | "Unassigned" view when nothing is unassigned still scans all leads (2.4 s); first view of a report after a quiet spell takes 1–2.5 s (§8) |

## 2. Targets

Set before the run (`DEVELOPMENT_PHASES.md` asked for "latency targets at 1M leads"):

| Kind of request | Target (p95, server time) |
|---|---|
| Lists, search, filters, lead detail, timeline, call queue, web-lead inbox, audit log, notification badge | ≤ 500 ms |
| Dashboard page and reports **when cached** | ≤ 500 ms (dashboard page), ≤ 200 ms (report API) |
| Dashboard and reports, **first view after the cache expired** | ≤ 3 s |
| Writes: add student, add note, change stage, log a call | ≤ 500 ms |
| Website enquiry (`POST /api/webleads`) | ≤ 500 ms |
| Errors (5xx, 429, timeouts) at the target pace | 0 |

## 3. What was measured, on what

**Data** (`pnpm load:seed`, SQL `generate_series`, deterministic, three years of history): the "bigco" agency with
1,000,000 students and leads in realistic stage and source proportions, 2 admins, 60 counselors and 88 telecallers,
about 1.7 assignments and 1.5 activities per lead, 2.1 million stage-history rows, 700,000 follow-ups (400,000 open, many
overdue or due soon), 180,000 notes, 200,000 web leads, 500,000 audit rows; plus 20 small agencies beside it (many
tenants is what row-level security has to plan across). 1.2 million leads in the database.

| Table | Rows | Table | Indexes |
|---|---|---|---|
| students | 1,200,020 | 239 MB | 624 MB |
| lead_status_history | 2,099,983 | 235 MB | 526 MB |
| activities | 1,799,948 | 290 MB | 419 MB |
| lead_assignments | 2,039,962 | 275 MB | 287 MB |
| leads | 1,200,000 | 180 MB | 265 MB |
| follow_ups | 707,958 | 123 MB | 116 MB |
| audit_logs | 500,058 | 85 MB | 113 MB |
| web_leads | 200,107 | 45 MB | 39 MB |

The whole database is **3.9 GB**: it fits in memory, so these are warm-cache numbers; a first request after a restart
is slower (the baseline's cold p95s show it). A database much larger than RAM needs its own test.

**Database:** a separate Postgres 17 container (`docker-compose.load.yml`, port 55460, `shared_buffers` 2 GB,
`work_mem` 32 MB, `effective_cache_size` 6 GB, `random_page_cost` 1.1, 200 connections, `pg_stat_statements`), run as
the same two roles the app uses. The seed and runner refuse any database not named `*_load`.

**Server:** the production build (`next start`), 10 database connections per web instance, the same code and rate
limits as production (each virtual person stays under them, as a real one does), sessions created directly in the database.

**Runner** (`pnpm load:run`): (1) a *baseline* — each of 21 kinds of request 60 times, one at a time, spread over the
people who do it; (2) a *mixed* run — 150 virtual staff (2 admins, 60 counselors, 88 telecallers) each repeatedly picking
an action by role-weighted frequency, pausing a random 0.5–1.5 × the think time, while websites post about 3 enquiries a
second. The actions are what a working day is made of: pages of leads, searches by phone digits, full name and first name,
filters by stage/source/state, "my leads / today / overdue", opening a lead and its timeline, the call queue, logging an
outcome, adding a note, changing a stage, adding a student, the web-lead inbox, the dashboard page, reports (mostly the
last 30 days, sometimes all time), the audit log and the notification badge. It prints a table, the statements the
database spent most time on, and writes JSON.

## 4. What the test found, and what was done

Most of these were invisible at the sizes the tests use. Times are at 1,000,000 leads.

| # | Finding | Before | After | Change |
|---|---|---|---|---|
| 1 | **The dashboard did a dozen separate counts and an all-time funnel in one transaction** and ran past the 15 s transaction limit | 21 s, then an error | 2.5 s cold; **instant when cached**; a person's own cards 0.3 s | Two passes (one over leads, one over follow-ups); funnel summarises stage history first; cached for a minute (§6) |
| 2 | **Row-level security stops Postgres using trigram indexes** (`LIKE`/`ILIKE` are not "leakproof"), so for the application role every name, parent and phone search scanned the table. The same query as the table owner took 7 ms | phone digits 3.5 s; a first name 6 s; a full name up to 3 s | phone digits 12–15 ms; a first name 50–215 ms | `search_student_ids`: a tenant-locked `SECURITY DEFINER` function that finds the students (`DATABASE_SCHEMA.md`); the list filters on their ids, or on the plain match when thousands match |
| 3 | The planner judged a longer common name rare and sorted a hundred thousand leads | 1–5 s per common-name search | 25 ms for the page, ≤ 190 ms to count | For that transaction only (and not for someone looking at just their own leads, where the default plan is better), whole-table scans and sorts are switched off, leaving the walk in index order |
| 4 | **`count({ take })` is `ORDER BY id`**: the "total" of a filtered list walked the primary key | 1 s ("state = Telangana") to 5.5 s | ≤ 190 ms | Count newest-first, like the list; the total stops at **"1,000+"**; a list that fits one page needs no count |
| 5 | A case-insensitive `ILIKE` tells the planner nothing about how many rows match | state filter 1.4 s | 27 ms | The same text is also matched exactly in its usual spellings, which gives it the column statistics |
| 6 | The conversion funnel grouped a lead–history join | 3.9 s all time | 1.0 s (history summarised first); 0.15 s for 30 days | Two query shapes, chosen by whether the report covers the whole agency; index `lead_status_history_funnel_idx` |
| 7 | Team report sorted a million assignments with `COUNT(DISTINCT)` | — | 1.6–1.9 s cold for 30 days | Plain counts (a lead has one active assignment per role: `lead_assignments_active_key`) |
| 8 | Searching by parent's name had no trigram index | 400 ms scan | (covered by 2) | `students_parent_name_trgm` |
| 9 | **The rate limit for adding a student (60 a minute) was shared with browsing the same path**: a counselor who had viewed 60 pages in a minute was refused | 429 on the load test's first write | fixed | Reads and writes of a route are counted apart (`apps/web/src/lib/api.ts`) |
| 10 | A duplicate index of mine (`follow_ups_open_idx`) repeated the existing `follow_ups_tenant_open` | — | removed | Caught by listing the table's indexes before keeping it |

Also found, in the test tooling, not the product: a Node server whose output pipe nobody reads freezes in the middle of
a request on Windows; the runner now writes the server's log to a file (`load-results/<label>.server.log`).

Tests that protect the fixes: `lead-search.int` (search, escaping, isolation of the function, thresholds, totals),
`reports-scale.int` (same numbers, safe cache), `observability.int` (cache on real Redis), the cache and metrics unit
tests, and the migration guard that the hand-written indexes are never dropped.

## 5. Results

### 5.1 The target pace — 150 staff, one action each about 5 seconds, one web server

`load-results/1m-realistic.json`. 2,786 requests in 90 s (29 a second), **0 errors**, p50 48 ms, p95 211 ms, p99 428 ms.

| Request | n | p50 ms | p95 ms | p99 ms | Target |
|---|---|---|---|---|---|
| leads: my leads / today / overdue | 251 | 118 | **493** | 614 | 500 ✓ (close) |
| leads: search by first name only | 19 | 241 | 417 | 417 | 500 ✓ |
| dashboard (page) | 342 | 128 | 258 | 428 | 500 ✓ |
| leads: first page, newest | 459 | 146 | 214 | 304 | 500 ✓ |
| leads: filter by stage and source | 61 | 79 | 172 | 206 | 500 ✓ |
| leads: search by phone digits | 56 | 24 | 138 | 174 | 500 ✓ |
| web leads: inbox | 4 | 102 | 128 | 128 | 500 ✓ |
| student: add a new one | 22 | 62 | 109 | 240 | 500 ✓ |
| leads: next page | 101 | 57 | 108 | 151 | 500 ✓ |
| intake: website enquiry | 258 | 37 | 87 | 147 | 500 ✓ |
| calls: log an outcome | 104 | 48 | 74 | 88 | 500 ✓ |
| leads: search by full name | 48 | 39 | 58 | 171 | 500 ✓ |
| calls: my queue | 568 | 23 | 48 | 131 | 500 ✓ |
| lead: add a note | 80 | 9 | 41 | 65 | 500 ✓ |
| lead: open one / timeline | 61 / 27 | 10 / 10 | 40 / 39 | 111 / 50 | 500 ✓ |
| notifications badge | 322 | 14 | 36 | 107 | 500 ✓ |
| reports (cached) | 3 | 6 | 11 | 11 | 200 ✓ |

The one-at-a-time baseline of the same run (what a single person feels with nobody else on) is within the same
targets: p95 above 100 ms only for "my leads / today / overdue" (460), the dashboard page (413, each person's first view
is computed, later ones are cached), first-name search (291), the first page (190), stage and source filter (144), web-lead
inbox (113). Two baseline rows are cold by design: the reports (p50 8 ms, p95 1.2 s, max 2.9 s: the first look at each
report) and "unassigned / closed views" (p95 2.9 s: §8).

Where the database spent its time: list queries for the people who work "their" leads (counselors and telecallers,
117–185 ms each) and the dashboard's lead pass (50 ms, 395 calls) — nothing near a limit (the slowest statements averaged under 200 ms apart from the empty "unassigned" view, §8).

### 5.2 Beyond the target — stress

Same data, one action about every 0.7 s per person (about 7× the pace):

| Run | Requests | Per second | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|
| 1 web server | 6,623 | 72 | 1,242 ms | 2,620 ms | 3,101 ms | 0 |
| 3 web servers | 10,738 | 117 | 454 ms | 1,381 ms | 2,038 ms | 0 |

With one server the response time was nearly the same for the cheapest and the dearest request (a notification badge
took p50 1.1 s): **the Node process was the bottleneck, not the database** — it is single-threaded and renders the
dashboard page and the JSON for every request. Web servers are stateless, so capacity grows by adding instances behind
the load balancer: three servers gave 1.6× the throughput and a third of the latency. It was not 3× because the load
generator, all three servers and the database were sharing one machine, so the ceiling had moved from the Node process to
the machine; on separate hosts expect closer to linear. (In that run each server also kept its own report cache, as
there was no Redis, so the first look at each report was computed three times at once under load: the reports' p95 of 8.9 s
is that, once. With `REDIS_URL` set the cache is shared.) Nothing failed under the stress: requests queued and were answered.

### 5.3 Dashboards and reports: cold and cached

| What | First view (computed) | Next views in the minute |
|---|---|---|
| Admin dashboard, all of it | 2.4–2.6 s | ≤ 10 ms for the cached parts; the queue, activity and web-lead count are read live (≈ 30 ms) |
| A counselor's dashboard | 0.3 s | cards live; trend and funnel cached |
| Funnel, all time / last 30 days | 1.0–1.1 s / 0.15 s | < 10 ms |
| Sources, all time | 0.3 s | < 10 ms |
| Team, last 30 days | 1.6–1.9 s | < 10 ms |
| Follow-ups report | 1.0–1.2 s | < 10 ms |

A cached answer is reused for 60 seconds and, for ten times as long, still served at once while a new one is computed
in the background; one computation runs at a time per answer (`REPORTING.md` §5).

## 6. Capacity and sizing

- **Web:** about **70 requests a second per instance** for this mix on this machine, and the realistic pace for 150
  staff is about 30. Start with two instances for availability; add one per ~50 requests a second at peak. They are
  stateless. Set `REDIS_URL` so rate limits and the report cache are shared.
- **Database:** 10 connections per web instance and 5 for the owner client: with 8 instances that is 120 of Postgres's
  connections; beyond that put PgBouncer in front. The 1.2M-lead database was 3.9 GB: give Postgres enough memory to
  hold it (this test used 2 GB shared buffers on a 12 GB machine), and `ANALYZE` after a large import.
- **Worker:** one is enough. Imports of 50,000 rows take about 90 s end to end (`IMPORT_EXPORT.md`), off the request path.
- **Per agency:** the test agency is far larger than typical. At 100,000 leads every figure above is about an order of
  magnitude smaller.
- **Redis:** counters, queue and cache; it can be lost without losing data.
- **Growth triggers** (`IMPROVEMENT_ROADMAP.md` P2): daily roll-up tables for reports above ~2M leads, partitioning
  `activities`, `audit_logs` and `lead_status_history` at ~50M rows, a read replica for reports, PgBouncer above ~8 instances.

## 7. Plans and usage metering

**Plans.** A plan is a code (Starter, Professional, Ultra, Enterprise), a name, a price and `limits` JSON:
`max_users`, `max_leads`, `storage_mb`. A missing or null limit means unlimited. A workspace with no plan has no limits.
The seeded limits: Starter 3 users / 5,000 leads / 1 GB; Professional 15 / 50,000 / 10 GB; Ultra 50 / 250,000 / 50 GB;
Enterprise unlimited (`packages/db/prisma/seed.ts`; the real tiers are the owner's to set). The platform console changes a workspace's plan; a move is refused, with the
reason, when the workspace already uses more than the new plan allows.

**Enforcement** is in the services, at the moment something is added, so it works the same from the API, the import
and the UI: creating or switching back on a user; adding a student; converting a web lead into a new lead; starting
an import (checked against the rows it would add, before it starts); starting a document upload. The refusal is a 409
with `details.code = "PLAN_LIMIT"` and a message that says which limit and what to do. **Website enquiries are never
refused** (they land in the inbox; only converting them counts), and nothing already saved is ever removed or hidden.

**Measuring.** `usage.getUsage` counts from the workspace's own rows (active users, undeleted leads, stored document
bytes, automation runs this month) and powers Settings → Plan and usage (`GET /api/usage`, admins). The worker writes
the same figures hourly into `usage_counters (tenant, metric, period)`, one row per metric and month, updated in
place, so a billing job can read a stable number per month. The platform list shows each agency's use against its limits.

**Not built:** payments, invoices and dunning (the model and the monthly counters are the interface), per-feature
quotas for automation runs or messages (`automation_runs` is measured but not limited), overage billing.

## 8. Known limits and what to do

| Limit | Effect | Next |
|---|---|---|
| "Unassigned" view when nothing is unassigned | Walks every lead (2.4 s at 1M) | Maintain a flag or partial index for leads with no active counselor (P2) |
| A one-word search that matches thousands | 50–215 ms for admins, ~300 ms for a counselor; the total says "1,000+" | Fine; a search engine only if patterns outgrow contains-matching |
| First view of a report after a quiet spell | 1–2.5 s once, then cached | Daily roll-ups (P2); invalidate on write (P2) |
| State and district filters rely on a planner workaround | Fast now | Normalise stored values and use a lower-case index (P2) |
| The 3.9 GB database fits in memory | Warm-cache numbers | Test on a dataset larger than RAM on the real host |
| One machine ran everything | Real network and a dedicated database server will shift the numbers | Re-run on staging |
| Other agencies were idle | A noisy neighbour is not measured | Load two or three agencies at once |
| Writes were light (about 10 % of requests) | Heavier write mixes (bulk imports during working hours) not measured | Import during a mixed run |

## 9. Reproduce

```bash
cd avn_cms
pnpm load:up && pnpm load:migrate                 # tuned Postgres on :55460, all migrations
pnpm load:seed --to 100000                         # then --from 100000 --to 1000000
pnpm build
pnpm load:run --label 1m --think 5000              # target pace; --think 700 for the stress run
pnpm load:run --label 1m-3x --think 700 --instances 3   # scale-out (servers on 3302, 3303, 3304)
pnpm exec tsx scripts/loadtest/probe.ts            # time single services without a server (set PROBE_NAMES=1 for all first names)
pnpm restore:drill                                 # backup/restore check of the same database
```

`--cache 0` turns the report cache off to measure the queries themselves; `--vus`, `--duration`, `--baseline` change
the shape. Results go to `load-results/<label>.json` and `.log`; the servers' own logs to `<label>.server.log`. The runs
quoted here are kept: `1m-realistic.json` (§5.1), `1m-stress-1x.json` and `1m-stress-3x.json` (§5.2), and
`restore-drill.log` (`RUNBOOK.md` §5.2).
Before trusting a number, look at `pg_stat_statements` (the runner prints the top statements) and `EXPLAIN (ANALYZE,
BUFFERS)` **as the application role with a workspace set**: the same query as the owner plans differently
(finding 2).
