# Test plan — aVn CMS

> What is tested, by which suite, how to run it, what each suite proves, and what is **not** covered. The numbers are
> from the last full run (`BUILD_STATUS.md` has the live record). Every phase added its suites as it was built; Phase 10
> adds the load test, the restore drill and the operations tests, and closes the list of gaps.

## 1. Principles

1. **The risk decides the layer.** Business rules are unit tested without I/O; anything involving Postgres, row-level
   security, Redis, MinIO or ClamAV is tested against the real thing; user journeys and the security of the delivered
   pages are tested in a real browser against a production build. Mocks of our own database layer are not used.
2. **Matrix tests over examples.** Where the rule is "every X must Y" (every role × action, every route × gate, every
   tenant-owned table has RLS), a test enumerates the X from the code or the file system, so a new X without its Y
   fails the build rather than slipping through.
3. **Security is tested per category** (`SECURITY.md` §3): authentication, authorization, tenant isolation, injection,
   XSS/CSP, CSRF/cross-site, uploads, exports, mass assignment, rate limits, sessions.
4. **Numbers reconcile.** Report figures are checked against raw counts from the same rows.
5. **Scale is measured, not assumed** (`SCALABILITY.md`): a million-lead load test and a restore drill with pass criteria.

## 2. Suites

| Layer | Command | Needs | Count | What it proves |
|---|---|---|---|---|
| Lint, architecture rules | `pnpm lint` | — | 0 warnings allowed | Import boundaries (the owner database client cannot be imported outside auth, platform and system jobs; pages and components call core services, never the database package), strict typing rules, React hooks rules |
| Formatting | `pnpm format:check` | — | | One style |
| Types | `pnpm typecheck` | — | 6 packages | Strict TypeScript across web, worker and packages |
| Unit | `pnpm test:unit` | nothing | 285 | RBAC matrix (every role × action cell), TOTP vectors (RFC 6238), crypto and keyed hashes, phone normalisation, keyset cursors, intake normaliser, import parsing and mapping, document type and signature rules, the clamd protocol, automation definitions and matching, client-address and redirect rules, password rules, page security policy, code rules for routes and pages, the answer cache, request metrics, log and heartbeat helpers |
| Integration | `pnpm test:integration` | Postgres test DB (and Redis, MinIO, ClamAV from `pnpm stack:up`) | 237 (24 files) | Real database with row-level security: tenancy, auth, leads, follow-ups, web-lead contract, reports, users and platform, imports (incl. 50,000 rows), exports, cut-off job recovery, job queue on real Redis, documents (EICAR virus never downloadable), automation, after-commit hook, two-step verification, the gate on every route, cross-workspace checks on every route, plans and usage, search and totals, operations (health, metrics, heartbeat, cache on Redis) |
| End to end | `pnpm test:e2e` | production build, Chromium, the docker stack | 48 (11 spec files) | Journeys for every role and critical path in a browser, with axe WCAG A/AA checks: sign-in, lead journey, call logging, RBAC, security headers/CSP/XSS/redirects, two-step verification, users, web-lead intake, import wizard, exports, documents, automation, plans |
| HTTP smoke | `pnpm smoke:webleads --url … --tenant …` | a running server | 7 checks | The LeadXP-compatible intake end to end, for a deployed environment (staging only) |
| Load | `pnpm load:run` | `pnpm load:up`, a seeded 1M-lead database, a build | — | Latency and error rate at 1,000,000 leads (`SCALABILITY.md` §5) |
| Restore drill | `pnpm restore:drill` | the load or any Postgres container | — | A backup restores and matches (`RUNBOOK.md` §5) |

All of unit, integration and e2e run in CI on every push and pull request (`.github/workflows/ci.yml`, Ubuntu with
Postgres 17, Redis, MinIO and ClamAV containers); `security.yml` adds dependency advisories, secret scanning and CodeQL.
**Both workflows are written and pass locally but have not run on GitHub yet.**

## 3. Where each requirement is tested

| Requirement (`REQUIREMENTS.md`) | Evidence |
|---|---|
| R-01–R-03 tenant isolation | `tenancy.int`, `security-tenant.int` (35 cross-workspace operations; every route as another workspace), RLS-on-every-table migration test |
| R-04–R-05 gate and envelope | `security-http.int` (every route: 401 without a session, 403 without CSRF or from another site, 422 for a non-JSON body, no stack traces) |
| R-06–R-09 auth, MFA, lock-out | `auth.int`, `mfa.int`, `auth.spec`, `security.spec` |
| R-10–R-12 RBAC, 404 for others', no mass assignment | policy matrix unit test; `security-tenant.int` (roles × routes); `rbac.spec` |
| R-13 audit | `leads.int`, `tenancy.int` (append-only for the app role), `users.spec` |
| R-20–R-32 CRM core | `leads.int`, `lead-search.int`, follow-up tests, `leads.spec` |
| R-40–R-42 intake | `webleads.int` (12 contract tests, both eWings payload shapes), smoke script, `webleads.spec` |
| R-43–R-44 dashboards, reports | `reports.int` and `reports-scale.int` (reconcile with raw counts, scoped by role, cache isolation), `leads.spec` |
| R-45–R-46 import, export | `imports.int`, `imports-50k.int`, `exports.int`, `job-recovery.int`, `enqueue-failure.int`, `import-export.spec` |
| R-47 documents | `documents.int`, `documents-ops.int`, `documents.spec` |
| R-48–R-49 automation, notifications | `automation.int`, `after-commit.int`, `automation.spec` |
| R-50 plans and usage | `usage.int` (limits, snapshot, plan change, HTTP), `plans.spec` |
| Q-03 large lists | load test (`SCALABILITY.md`) |
| Phase 10 exits | load test at 1M leads; `restore:drill`; `observability.int` |

## 4. The end-to-end journeys

Roles: platform admin, agency admin, two counselors, one telecaller (a second workspace exists to prove isolation).

| Spec | Journeys |
|---|---|
| `auth` | Wrong password refused with one generic message, the right one lands on the dashboard; telecallers land on their call queue; signed-out visitors are sent to sign-in and the API answers 401; the CSP carries a per-request nonce; signing out ends the session |
| `leads` | Add a student → duplicate caught → search → change stage → assign → schedule → log a call (timeline shows it); dashboard, follow-ups and reports render from real data |
| `rbac` | Telecaller: no admin pages, API refuses admin actions. Counselor: sees only own leads, 404 for a colleague's, CSRF-less writes refused |
| `users` | Invite a counselor → they set a password and sign in with counselor access; settings, audit, account pages; super admin opens an agency (banner, audited) |
| `webleads` | Create a credential → LeadXP-format POST → inbox → convert |
| `import-export` | Upload → match columns → check problems → import → students appear; the import list shows it; a stopped import is shown and starts over without adding anyone twice; export from the leads screen downloads a file and the exports list keeps it; a telecaller gets no import screens and a reduced export |
| `documents` | Upload → scan → download → verify → new version, an infected file blocked; a counselor works on own leads only; a telecaller has no access; folders, files, versions and downloads; scans that gave up are listed and "Scan again" releases them; a counselor cannot see or use that list |
| `automation` | Every starter rule fires (the two time-based ones through the worker's sweep); rule builder; routed web lead through to the counselor; a rule that is off; admins only; phone width |
| `security` | Full header policy and the CSP nonce on every script; API responses uncacheable and loading nothing; session cookie flags; no page blocked by its own policy; markup in a student, web lead, notification and rule name shown as text; no redirect to another site after sign-in, and back to the asked-for page; two-step set-up, sign-in with a code and a recovery code, pause after wrong codes |
| `telecaller` | A telecaller logs an outcome from the queue (the call leaves it and appears under Closed); their dashboard shows only their own cards |
| `plans` | Admin sees plan and use; counselor refused; super admin changes a plan (a plan that does not fit is refused, a bigger one accepted) |

Accessibility (axe, serious and critical) runs on the main pages inside these journeys. Phone-width checks (no sideways
scroll) run on the lists and the vault.

## 5. Environments and data

- **Databases.** `avn_cms_test` on the docker Postgres (`pnpm stack:up`, port 55450) for integration and e2e; the schema
  is migrated for you and data is reset between files. `resetTestDatabase` refuses a name that does not end in `_test`.
  The load and restore tests use a separate container and database ending in `_load` (port 55460) and refuse others.
- **Redis** database 15 for the queue and operations tests (the helpers refuse database 0).
- **Test data** is built with factories (`tests/fixtures/factory.ts`: tenants, users, leads, web-lead submissions). The
  seed (`pnpm db:seed`) is for local demos and the browser tests and refuses to run in production.
- **Secrets** in tests are throwaway values; the test environment forces `REPORT_CACHE_SECONDS=0`, one trusted proxy
  hop, no SMTP and the test bucket (`tests/setup/env.ts`).

## 6. Load test and restore drill (Phase 10 exit criteria)

*Load test* — passes when, at 1,000,000 leads, at the target pace (150 staff, one action each about 5 seconds, plus
websites posting enquiries), there are **no errors** and every request kind meets its target (reads p95 ≤ 500 ms,
cached dashboard/report ≤ 200 ms, writes p95 ≤ 500 ms). Results and the findings fixed on the way are in
`SCALABILITY.md`. The runner also reports a one-person-at-a-time baseline, a stress run beyond the target, and the
statements the database spent most time on.

*Restore drill* — passes (exit code 0) when the restored copy has the same rows in every table, the same indexes,
constraints, policies, functions, extensions and types, the same migration history, row-level security still limits the
application role, and it still cannot read password hashes.

## 7. What is not covered

| Gap | Why | Plan |
|---|---|---|
| A real host: TLS, proxy header behaviour, `TRUSTED_PROXY_HOPS`, CDN | No hosting target | `DEPLOYMENT.md` §6a checklist on the first staging deploy |
| Cloudflare R2 itself (CORS, signed upload behaviour) | No account yet | One real upload/scan/download before go-live (`DOCUMENTS.md` §9) |
| Independent penetration test, DAST (ZAP) of staging | Needs a vendor and a staging host | `IMPROVEMENT_ROADMAP.md` P0 #3 |
| WebKit and Firefox | Chromium only | Add projects to Playwright config |
| The worker process killed mid-run | The cut-off is reproduced through the database and by failing a live run | Chaos test on staging |
| CI on GitHub | Written, never run there | Push, then enable branch protection |
| Load above one million leads, several agencies loaded at once, a production-sized machine | One laptop shared by the generator, the server and the database | Re-run on the real host |
| Real email delivery, telephony, WhatsApp | Not integrated | With those features |
| Visual regression | Not set up | Optional |

## 8. Adding a test

Put a business rule in a unit test next to the code. Anything that touches the database goes in `tests/integration`
(use the factories; never share data between tests; call the service or the route handler, not private helpers). A new
API route needs nothing extra for the gate (the route walk covers it) but needs an action or `roles` — otherwise the walk
fails — and a row in the role matrix test if it introduces a policy action. **After adding or removing an API route file,
delete `node_modules/.vitest-cache`**: the route helper finds routes with a build-time glob, and a cached transform of
the helper keeps the old list (three new routes were invisible to the tests once; CI starts clean, so only local runs
are affected). A user-visible journey goes in
`tests/e2e/specs` with `expectAccessible(page)` at its end. Anything that finds a bug gets a regression test first.
