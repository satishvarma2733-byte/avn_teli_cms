# Improvement roadmap — aVn CMS

> What to do next, grouped by urgency. **P0** blocks real customer data; **P1** is what customers will ask for in the
> first months; **P2** is scale and cost work triggered by growth; **P3** is later bets. Sources: the known gaps in
> `BUILD_STATUS.md`, the security review (`SECURITY.md` §8), the load test (`SCALABILITY.md` §9), `UX_IMPROVEMENTS.md`
> and `AI_ROADMAP.md`. Items marked **owner** need a decision, an account or a purchase from the product owner.

## P0 — before real customer data goes in

| # | Item | Why | Needs |
|---|---|---|---|
| 1 | **Choose a hosting target**; stand up staging and production (Node server, Postgres 15+, Redis, worker) | Nothing has run on a real host; `DEPLOYMENT.md` is verified on a laptop only | owner |
| 2 | **TLS, `APP_URL=https://…`, `TRUSTED_PROXY_HOPS`**, `MFA_REQUIRED_ROLES=SUPER_ADMIN,TENANT_ADMIN` | The default ignores the proxy header; sign-in would be limited site-wide behind a load balancer | host |
| 3 | **Independent penetration test** and a ZAP scan of staging | The 15 internal findings were found by us | owner |
| 4 | **Real Cloudflare R2 and a private ClamAV host**; one real upload/scan/download; R2 CORS rules | Documents are tested on MinIO only | owner (credentials via `.env`) |
| 5 | **Scheduled backups with an off-site copy**, and a first restore drill on the real host | The drill passes locally (`RUNBOOK.md` §5); a backup nobody has restored on production is a hope | host |
| 6 | **Wire the alerts** in `RUNBOOK.md` §2 to a pager or chat (health, 5xx rate, worker heartbeat, failed jobs, slow requests) | The signals exist; nobody is paged yet | host |
| 7 | **A way back for someone who lost their authenticator and recovery codes** | Today the only route is an operator clearing the MFA columns by hand (`RUNBOOK.md` §6) | build |
| 8 | **Enable GitHub private vulnerability reporting, Dependabot and branch protection**; run the CI and security workflows once | Written, never run on GitHub | owner |
| 9 | **Email delivery (SMTP provider)** for invitations and resets | Without it the admin copies links by hand | owner |
| 10 | Reset the local dev database to load the corrected seed | Cosmetic, dev only | owner (destructive) |

## P1 — first months

| # | Item | Notes |
|---|---|---|
| 11 | **Telephony**: click-to-call from the browser or a phone app, call duration and recording link logged on the call | Needs a provider decision (Exotel, Knowlarity, Twilio…); the follow-up model already has the disposition and timeline entry |
| 12 | **WhatsApp Business** templates and a shared inbox; delivery status in the timeline | Needs Meta approval and a BSP |
| 13 | **Email and SMS** notifications and reminders; sign-in alert emails | Provider decision |
| 14 | **Real-time notifications** (server-sent events) replacing the one-minute poll | `UX_IMPROVEMENTS.md` §3 |
| 15 | **Billing**: invoices and payments from `usage_counters` and plan limits | Provider decision (Razorpay / Stripe); metering is ready |
| 16 | **Duplicate merge** screen; fuzzy duplicate detection (name + parent + place) | |
| 17 | **Saved views, "select all matching", report export and scheduled report email** | `UX_IMPROVEMENTS.md` §3 |
| 18 | **Call-queue keyboard shortcuts** and a call-mode page | |
| 19 | **Ad-platform intake**: Meta Lead Ads, Google Ads lead forms → web leads | The intake pipeline accepts them already; the connectors are missing |
| 20 | **Switch the eWings websites** to the new endpoint, site by site, using the rollback in `WEBLEADS_COMPATIBILITY.md` §7 | Owner decision; no website was touched |
| 21 | **Custom fields** per agency (course intake year, NEET score, budget) | The web-lead payload already carries some of these |
| 22 | **First-run checklist** and demo data for a new agency | |
| 23 | **Audit-log archive and export** beyond a retention window | `AUDIT_LOGGING.md` §5 |

## P2 — when growth asks for it

| # | Item | Trigger |
|---|---|---|
| 24 | **Daily roll-up tables** for the funnel and team report (computed by the worker, read in milliseconds) | An agency above ~2M leads, or the first-view report time (`SCALABILITY.md` §5) becoming a complaint |
| 25 | **Invalidate the report cache on write** (or per-agency version keys) instead of waiting out the minute | Users noticing stale dashboard figures |
| 26 | **Read replica** for reports and exports | Report load competing with calls on the primary |
| 27 | **Partition** `activities`, `audit_logs`, `lead_status_history` by month | ~50M rows in any of them |
| 28 | **Separate worker pools** for imports/exports and for latency-sensitive automation runs; queue priorities | Large imports delaying escalations |
| 29 | **Per-agency rate limits and fair-share** in the job queue | A noisy tenant |
| 30 | **Connection pooler** (PgBouncer) in front of Postgres | More than ~8 web instances |
| 31 | **Search engine** (Postgres full-text or an external index) for fuzzy and multi-field search | Search patterns beyond contains-matching |
| 32 | **Student-search function for state/district too**; normalise stored state names | The case-insensitive filter works through an index-friendly workaround today |

## P3 — later bets

Passkeys and SSO (SAML/OIDC) for large agencies; data-residency choices; a mobile app for telecallers; multi-language
UI; a partner/referral portal; a public API with tokens for agency integrations; marketplace of automation templates;
the AI features in `AI_ROADMAP.md`.

## How items move

An item becomes a phase task when it has an owner decision (where marked), an acceptance test and a place in the next
phase plan. Findings from the penetration test and from the first real agency go straight into P0/P1 regardless of
where they were on this list.
