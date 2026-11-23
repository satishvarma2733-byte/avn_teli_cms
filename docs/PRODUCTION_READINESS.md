# Production readiness report — aVn CMS

> Written 2026-11-23 from a fresh run of every check on this machine (Windows 11, Node 24, Docker Desktop). Each line says
> what was run. **PASS** is used only where something was actually run and passed. Nothing here has run on a real host:
> there is no hosting target yet (`BUILD_STATUS.md`, decision 2).

## 1. Verdict

The application is **ready to be put on a staging host**. It is not "deployed" and not yet fit for real customer data: what
stands between here and that is not code but the owner's decisions and accounts (§5): a host, DNS, a real Cloudflare R2
bucket, an SMTP provider, and an independent penetration test. Everything that could be checked without them was.

## 2. Final audit

| Category | Status | What was run, and what is left |
|---|---|---|
| Project architecture | **PASS** | Next.js 16 app, a BullMQ worker, four packages; tenancy through Postgres row-level security; import-boundary lint rules (`ARCHITECTURE.md`, `MODULE_STRUCTURE.md`). All 10 migrations apply cleanly to an empty database inside the production container |
| UI/UX | **PASS** (implemented) | axe WCAG A/AA (serious and critical) on every screen in the browser suite. Whether the look is "premium" is a design judgement this review cannot make; no design review was done |
| Mobile responsiveness | **PASS** | `responsive.spec.ts`: 17 admin screens, a lead's page, the platform console and the signed-out pages at 390 px and 768 px, each checked for sideways scrolling, accessibility and the menu button. It found three tables a keyboard user could not scroll (the audit log and two on Reports); fixed |
| Frontend functionality | **PASS** | Browser suite: 99 tests in Chromium, 94 in Firefox, 94 in WebKit (5 Chromium-only timing tests skip elsewhere), all passing (§3) |
| Backend functionality | **PASS** | 304 unit tests; 255 integration tests on real Postgres, Redis, MinIO and ClamAV (every route's gate, cross-workspace checks, queue on real Redis, virus-scanned documents, 50,000-row import) |
| Database | **PASS** | RLS tests; migrations from empty; restore drill (`pnpm restore:drill`, `RUNBOOK.md` §5); 1,000,000-lead load test (`SCALABILITY.md`); `deploy/backup.sh` writes a dump that `pg_restore --list` reads. Postgres 18 is deliberately not used yet |
| Authentication | **PASS** | Argon2id, lock-out, sessions, two-step verification with recovery codes, admin reset of a lost factor. In the production container: a super admin was created, set a password and signed in, and was sent to two-step setup (`MFA_REQUIRED_ROLES` defaults to admins in the recipe) |
| API integrations | **NEEDS CONFIGURATION** | See §4. Postgres, Redis, ClamAV and MinIO (S3 API) are tested for real. **Cloudflare R2 and SMTP have never run against a real account**; eWings is compatibility-only by decision; no payment, telephony or WhatsApp provider exists |
| Security | **PASS** (internal) / **NEEDS CONFIGURATION** | `SECURITY.md`: internal penetration-test checklist run as tests; `pnpm audit` is clean apart from one accepted advisory (§3). On the container: HSTS, CSP with nonce, `X-Frame-Options`, no `Server` header on HTTPS answers, HTTP→HTTPS redirect, protected pages redirect to sign-in. **Still to do: an independent penetration test and a ZAP scan of staging; `TRUSTED_PROXY_HOPS` checked on the real proxy** |
| SEO | **NOT APPLICABLE** (indexing) / **PASS** (the rest) | A private, signed-in CRM should not be indexed: every page is `noindex`, and `/robots.txt` now says `Disallow: /`. Sitemap, Open Graph, structured data and Search Console are not applicable. The custom 404 page exists and is checked. No Google Analytics, Tag Manager or other tracking is in the code |
| Performance | **PASS** (measured locally) | `performance.spec.ts`, production build, Chromium, localhost: sign-in 136–256 ms and the main screens 156–568 ms to Largest Contentful Paint, layout shift 0.000–0.001, 183–218 kB of scripts, first byte under 35 ms (budgets: 2.5 s, 0.1, 450 kB, 800 ms). Load test: 0 errors at 1M leads. **Lighthouse and real-network Core Web Vitals were not run** (they need the real host) |
| Browser compatibility | **PASS** (with limits) | The whole suite passes in Chromium, Firefox 155 and Playwright's WebKit (the engine under Safari). **Not run:** Safari itself, Edge itself (same engine as Chromium), real phones |
| Production build | **PASS** | `pnpm build`; the Docker image builds (2.24 GB; could be slimmed with `pnpm deploy`) |
| Deployment configuration | **NEEDS CONFIGURATION** | Prepared and run locally: `Dockerfile`, `deploy/docker-compose.prod.yml` (web, worker, migrate, Postgres, Redis, ClamAV, Caddy), `deploy.sh`, `backup.sh`; the full stack came up with `deploy.sh`, health was 200 through HTTPS with every dependency `up`. **Not verified:** a real DNS name, a real Let's Encrypt certificate (locally Caddy used its own), a real server |
| Backup and rollback | **PASS** (documented and scripted) / **NEEDS CONFIGURATION** | `DEPLOYMENT.md` §4a, §7, §8 and `RUNBOOK.md` §5. The schedule, the off-site copy, the bucket copy for documents and a first restore on the real host are the host's to do |

## 3. What was run for this report

| Check | Result |
|---|---|
| `pnpm lint` (0 warnings), `pnpm format:check`, `pnpm typecheck` (6 packages) | pass |
| `pnpm test:unit` | **304 passed** (21 files) |
| `pnpm test:integration` | **255 passed** (26 files) |
| `pnpm test:e2e` (build + Chromium) | **99 passed** (13 spec files) |
| `E2E_BROWSERS=firefox pnpm test:e2e:only` | **94 passed**, 5 skipped (Chromium-only performance budgets) |
| `E2E_BROWSERS=webkit pnpm test:e2e:only` | **94 passed**, 5 skipped |
| `pnpm audit --audit-level moderate` | 1 advisory left, accepted and recorded (`minimatch`, `SECURITY.md` §2.6) |
| Docker image + `deploy/deploy.sh` + `deploy/backup.sh` + first super admin inside the container | all ran; HTTPS health `{"status":"ok","database":"up","redis":"up","scanner":"up","worker":"up"}` (`storage` is `not_configured` without R2) |
| Empty submissions of six forms (sign-in, new student, add user, new folder, new rule, new credential) | four say what to fill in; two (folder, credential) keep the button disabled; **the new-student form showed a validation library's own wording and was fixed** |

## 4. Integrations

| Service | Used for | State |
|---|---|---|
| PostgreSQL 17 | all data | tested (integration, load, restore) |
| Redis 8 | queue, rate limits, report cache, worker heartbeat | tested on a real Redis |
| ClamAV | virus scan before a document is released | tested (an EICAR file is never downloadable); runs in the production recipe |
| Cloudflare R2 (S3 API) | document storage | **NEEDS CONFIGURATION**: tested on MinIO, never on R2; set its CORS rules (`DOCUMENTS.md` §9) and make one real upload, scan and download |
| SMTP | invitations and password resets | **NEEDS CONFIGURATION**: without it the admin is shown a one-time link; no provider chosen |
| eWings / LeadXP website intake | `POST /api/webleads` | compatible with both payload shapes (12 contract tests, smoke script); no eWings code changed, by decision |
| Telephony, WhatsApp, SMS, payments | — | not built; provider decisions needed (`IMPROVEMENT_ROADMAP.md` P1) |
| Google Analytics, Tag Manager, Search Console | — | not applicable: a private app, none present |

## 5. What the owner has to do (in order)

1. **Choose a host** that can run Docker or Node plus Postgres and Redis. A shared "business" web-hosting plan cannot run
   this (`DEPLOYMENT.md` §4a). Then follow `DEPLOYMENT.md` §4a: DNS, `deploy/.env.production`, `sh deploy/deploy.sh`.
2. **Supply the accounts:** Cloudflare R2 (bucket, token, CORS) and an SMTP provider.
3. Work through `DEPLOYMENT.md` §6a on the real host: check `TRUSTED_PROXY_HOPS` from two networks, have every admin enrol
   two-step verification, and keep the database, Redis and ClamAV off the internet (the recipe publishes only 80 and 443).
4. **Schedule `deploy/backup.sh`**, copy its dumps and the R2 bucket off the server, and run `pnpm restore:drill` once there.
5. **Wire the alerts** in `RUNBOOK.md` §2.3 (health, 5xx, worker heartbeat, failed jobs).
6. **Independent penetration test and a ZAP scan of staging**; fix what they find before real data goes in.
7. In GitHub: private vulnerability reporting and branch protection that requires CI (`BUILD_STATUS.md`, decision 1).

Environment variables: the full list with how to generate each secret is `avn_cms/deploy/.env.production.example`
(reasons and defaults: `DEPLOYMENT.md` §2). Required for any deployment: `APP_HOST`, `POSTGRES_PASSWORD`,
`AVN_APP_PASSWORD`, `REDIS_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY`. Keep a copy of the last two apart from the
database backups: two-step secrets cannot be read without `ENCRYPTION_KEY`.

## 6. Found and fixed during this review

| Finding | How it was found | Fix |
|---|---|---|
| Three horizontally scrolling tables (the audit log and two on Reports) could not be scrolled with the keyboard (axe `scrollable-region-focusable`) | the new every-screen phone/tablet sweep | `scrollRegionProps()` (focusable, named region) on all ten table wrappers |
| The new-student form answered an empty submit with "Invalid input: expected string, received undefined" and "Invalid id." | probing forms with empty submissions | the schemas now carry plain messages for a missing field as well as an empty one; unit and browser tests |
| A new high advisory in `effect` ≤3.22.0 (reached only through Prisma's tooling) would have failed the weekly security scan | `pnpm audit` | pinned to `^3.22.5` with a pnpm override (`SECURITY.md` §2.6) |
| `deploy/deploy.sh` reported "Deployed" even when the final health check failed | running the script | the check now fails the script; `CURL_OPTS=-k` for a local test |
| WebKit lost text typed into a form before its scripts had run (a test is far faster than a person), so seven browser tests failed in WebKit only | running the suite in WebKit | tests now wait for the page to finish loading before typing (`gotoReady`); the cookie test no longer relies on WebKit's cookie API, which reports `SameSite=Lax` as `None` |
| No `robots.txt` | SEO audit | `/robots.txt` disallows everything (private app) |
| No way to run the app on a server short of assembling it by hand; no browser engine but Chromium | the deployment and compatibility phases | the Docker recipe in `avn_cms/deploy/` and `E2E_BROWSERS=firefox|webkit` |

## 7. Not done, and why

- **No real host, DNS name or certificate** (no hosting target). Caddy's automatic HTTPS is configured, but only its local
  certificate was exercised.
- **R2 and SMTP never run against real accounts** (no accounts).
- **No Lighthouse run and no real-network measurements**: the numbers in §2 come from a production build on localhost.
- **Safari, Edge and real phones were not run**; Firefox and WebKit ran through Playwright.
- **Slow-network and dropped-connection behaviour** has no automated test (the app's own timeouts on mail and storage do:
  `external-timeouts.int.test.ts`).
- **No independent penetration test.**
- **The Docker image is large** (2.24 GB) because it carries the whole workspace and its development tools; it works, and
  can be slimmed later.
- A person typing into a form in the first moment before its scripts have loaded can still lose that text (the forms are
  controlled by the page's scripts); in practice this takes a very slow device. Not changed here.

## 8. Reproduce

```bash
cd avn_cms
pnpm stack:up                                   # Postgres, Redis, MinIO, ClamAV, Mailpit
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test:unit && pnpm test:integration
pnpm test:e2e                                   # build + Chromium
pnpm exec playwright install firefox webkit     # once
E2E_BROWSERS=firefox pnpm test:e2e:only
E2E_BROWSERS=webkit pnpm test:e2e:only
pnpm audit --audit-level moderate
docker build -t avn-cms .                       # the production image
```
