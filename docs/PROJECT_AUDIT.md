# Project Audit — aVn CMS

> Discovery record for the build. Written 2026-10-15 from a full read of the folder.
> Facts first, then conflicts and the decisions taken to resolve them.

---

## 1. What exists

| Path | Content | State |
|---|---|---|
| `README.md` | Product overview, stack, non-negotiables | Planning doc, renamed to aVn CMS |
| `docs/ARCHITECTURE.md` | Single Next.js app + worker, row-level tenancy + RLS, request lifecycle, layering, modules, Student ≠ Lead, stage/disposition split, decisions D1–D8 | Planning doc |
| `docs/DATABASE_SCHEMA.md` | All tables, enums, indexes, Prisma sketch, RLS | Planning doc |
| `docs/RBAC_MATRIX.md` | 4 roles × resources × ownership; enforcement rules; test obligations | Planning doc |
| `docs/PAGES_AND_ROUTES.md` | Page tree per role, URL structure, full API route list | Planning doc |
| `docs/MODULE_STRUCTURE.md` | pnpm workspace layout, four-layer modules, lint-enforced boundaries | Planning doc |
| `docs/DEVELOPMENT_PHASES.md` | Phases 0–10 with exit criteria | Planning doc (Phase 0 ✅) |
| `docs/WEBLEADS_COMPATIBILITY.md` | LeadXP-compatible `/api/webleads` intake | Planning doc |
| `avn_cms/` | Empty folder chosen by the owner as the code root | Empty |

**No source code, manifests, migrations, tests, env examples or deployment files existed.**
There is no "LeadXP Clone implementation" to reuse; this folder is the only LeadXP clone
and it was planning-only. The original product (`leadxp.aikosoft.ai`) is external and its
source is not available here — its behaviour is known only through the review captured
in the docs (live statuses, roles, sources, dashboard cards).

**Git:** the folder had no repository of its own; `git` resolved to the unrelated
home-directory repository. On 2026-10-15 a dedicated repository was initialised at
`Desktop\leadxp-rebuild` (branch `main`, no commits yet) and the two files previously
staged in the home repository were removed from that index only (files untouched).

---

## 2. Original LeadXP features to keep (from the docs)

Follow-up call queue (Today/Upcoming/Pending/Closed) · inline reassignment · source
tagging (`SHEET_DATA, GOOGLE_ADS, META_ADS, DIRECT_CALL, REFERENCE, WEBSITE, WALK_IN, OTHER`) ·
web-leads inbox · four roles (Super Admin, Tenant Admin, Counselor, Telecaller) ·
dashboard cards (Total Active, Calls Today, Potential, Enrolled) · Potential/HOT markers ·
users workspace · educational folders vault · CSV import.

## 3. Gaps the rebuild must fix (from README / ARCHITECTURE)

Activity timeline · click-to-call + disposition logging · WhatsApp · funnel / source-ROI /
per-agent reporting · dedupe + intake validation · one stage + one disposition · bulk
actions · server-enforced tenancy and RBAC.

---

## 4. Conflicts between the master build prompt and the documented scope

| Prompt item | Documented scope | Decision |
|---|---|---|
| Payload CMS "if required" | Not in the stack or any doc. "CMS" here = documents vault, settings, admin | **Not used.** Adding a second framework/auth system would conflict with D1 |
| AI providers + agents (OpenAI, Claude, Gemini, Sarvam) | `AI_ROADMAP.md` is a Phase-10 *document*; no AI module in v1 | **Not built in v1.** Recorded as a future module behind the same layering |
| Visual workflow builder | Phase 8 "Automation": trigger → conditions → actions rule engine + rule builder UI | Built as the documented rule engine (Phase 8), not a canvas builder |
| eWings integration that forwards to LeadXP | Owner, 2026-10-15: "right now not integrate to ewings… add compatibility, we will add later". Never modify eWings code | **Compatibility only:** inbound `POST /api/webleads` per `WEBLEADS_COMPATIBILITY.md`. Outbound forwarding to LeadXP is not built; LeadXP's response contract is unverified |
| Organizations / teams | Tenants (agencies); no team entity | Tenants = organizations. Teams not added |
| Webhook creation / outbound delivery | Inbound intake webhooks only (`/api/public/webhooks/leads`) | Inbound only; outbound webhooks not in scope |

## 5. Technical decisions for the build

| # | Decision | Reason |
|---|---|---|
| B1 | Code root `avn_cms/` (owner's choice); docs stay in `docs/` | Owner pointed the build at `avn_cms/` |
| B2 | pnpm workspace scripts (`pnpm -r`) instead of Turborepo | Fewer moving parts; turbo can be added without code changes |
| B3 | Versions already proven on this machine: Next.js 16, React 19, Prisma 7.10 (+ `@prisma/adapter-pg`), Zod 4, Tailwind 4, TypeScript 6, Vitest 5, ESLint 10, Playwright 1.63, `@node-rs/argon2` | Same toolchain runs in the owner's other projects here |
| B4 | Custom session auth (DB sessions, opaque token in httpOnly cookie, Argon2id) rather than Auth.js | MFA, session listing and revoke-other-devices are required; README allows "or custom" |
| B5 | Login = workspace (tenant slug) + email + password; blank workspace = platform account | `users.email` is unique **per tenant**, so email alone can't pick the account |
| B6 | Two DB roles: `avn_app` (RLS enforced) for tenant data; owner role only for migrations, auth lookups and super-admin | RLS backstop needs a non-owner role; matches ARCHITECTURE §2 |
| B7 | Local ports: Postgres 55450, Redis 16390, MinIO 59100/59101, Mailpit 51125/58125, web 3300 | 5432/6379 and several 5xxxx ports are taken on this machine |

## 6. Risks

- **Scope vs. time:** ten phases. Work is staged; `BUILD_STATUS.md` records what is
  verified versus outstanding. Nothing is marked done without its exit check.
- **No hosting target documented** (`DEPLOYMENT.md` is a Phase-10 doc). Deployment
  readiness can only be verified locally until a host is chosen.
- **Unverified external contract:** LeadXP response format (only relevant if outbound
  forwarding is approved later).
- **Leaked credential (outside this repo):** a LeadXP username/password is committed in
  `ewings-website--main/scratch/_retired/deploy_blog.mjs`; owner to rotate.
