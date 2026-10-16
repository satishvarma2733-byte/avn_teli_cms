# Module & Folder Structure

> Review item 5 of 6. The on-disk layout and the conventions that keep business logic out
> of route handlers and security logic centralized. Every domain module repeats the same
> four-layer shape from [`ARCHITECTURE.md`](ARCHITECTURE.md) §4.

---

## Top level

A single pnpm workspace. One Next.js app, one worker entrypoint, shared packages.

```
leadxp-rebuild/
├── apps/
│   ├── web/                     Next.js app (UI + API routes + server actions)
│   └── worker/                  BullMQ consumers (imports, exports, reminders, automations, comms)
├── packages/
│   ├── db/                      Prisma schema, migrations, seed, tenant-scoped client
│   ├── core/                    domain modules (services, repositories, policies, validators)
│   ├── auth/                    session, password, MFA, tenant-context builder
│   ├── config/                  env parsing (Zod), constants, feature flags
│   ├── ui/                      shadcn/ui components, design tokens, table/form primitives
│   └── test-utils/              fixtures, factory builders, RBAC matrix harness
├── docs/                        ← this folder
├── .env.example
├── docker-compose.yml           postgres + redis + minio (local S3)
├── package.json  pnpm-workspace.yaml  turbo.json
└── tsconfig.base.json
```

Why a workspace rather than one flat Next app: it forces the dependency direction
(`web` and `worker` both depend on `core`/`db`, never the reverse) so the same service
code runs in a request and in a background job without duplication.

### As built (2026-10-16) — differences from the plan above

| Plan | Built | Why |
|---|---|---|
| Workspace at the repo root | Workspace in `avn_cms/` (docs stay in `docs/`) | Owner chose `avn_cms/` as the code root |
| `packages/ui` | `apps/web/src/components/ui` | Only the web app renders UI; keeps Tailwind scanning and Radix deps in one package. Move to a package if a second UI consumer appears |
| `packages/test-utils` | `avn_cms/tests/{fixtures,setup,integration,e2e}` | Fixtures need the owner client and the web route handlers; one place for all suites |
| `turbo.json` | `pnpm -r` scripts | Fewer moving parts; Turborepo can be added without code changes |
| Routes via `require-context.ts` + `authorize.ts` | `apps/web/src/lib/api.ts` → `route(options, handler)` | One gate: session → MFA → CSRF/origin → tenant ctx → rate limit → handler → envelope / errors |
| One repository file per module | `*.repository.ts` where queries are shared (leads, activities, assignments); simpler modules query inside the service through the **scoped** client | The scoped client + RLS are the security boundary; ESLint still forbids the owner client and raw Prisma imports outside the allowed modules |
| `docker-compose.yml` with MinIO | Postgres 17, Redis, Mailpit, MinIO and ClamAV | MinIO stands in for Cloudflare R2 locally; ClamAV scans uploaded documents (Phase 7) |

Import boundaries are enforced by `avn_cms/eslint.config.js`: the RLS-bypassing owner client
only in `packages/auth`, `core/platform`, the intake-credential lookup, worker system jobs,
`packages/db`, tests and scripts; the generated Prisma client only inside `packages/db`;
pages and components may import only `@avn-cms/db/enums` from the data layer.

---

## `packages/core` — the domain

One folder per domain module from the Architecture. Each is identical in shape:

```
packages/core/src/
├── students/
│   ├── student.service.ts        business logic, transactions, emits audit + events
│   ├── student.repository.ts     ONLY file here allowed to import the Prisma client
│   ├── student.policy.ts         pure can(ctx, action, resource) functions
│   ├── student.schema.ts         Zod DTOs (shared by API route AND service)
│   ├── student.types.ts          domain types
│   └── __tests__/                unit tests (service + policy + dedupe rules)
├── leads/              …same shape
├── assignments/        …
├── followups/          …
├── activities/         …
├── webLeads/           …   (+ leadxp-compat.mapper.ts: both live payload shapes → one DTO; intake-credential.service.ts)
├── imports/            …
├── exports/            …
├── documents/          …
├── reports/            …
├── notifications/      …
├── automations/        …
├── audit/              …
├── communications/     …   (whatsapp / email / sms / telephony adapters behind one interface)
├── tenants/            …
├── users/              …
└── shared/
    ├── context.ts                TenantContext type + builder contract
    ├── errors.ts                 AppError + stable error codes
    ├── events.ts                 domain event bus (in-process → worker)
    ├── pagination.ts             cursor helpers
    └── result.ts                 response envelope helpers
```

### The four layers, concretely

```ts
// route (apps/web/app/api/students/route.ts) — no business rules
export async function POST(req: Request) {
  const ctx = await requireContext(req);                 // auth + tenant + rate-limit
  const dto = StudentCreateSchema.parse(await req.json()); // validate (Zod)
  authorize(ctx, "student:create");                       // policy
  const student = await studentService.create(ctx, dto);  // service
  return ok(student);                                     // envelope
}

// service — logic + transaction + audit; never imports Prisma
async function create(ctx: Ctx, dto: StudentCreateDTO) {
  const existing = await studentRepo.findByPhone(ctx, dto.phoneE164); // dedupe
  if (existing) throw new AppError("CONFLICT", "Phone already exists", { studentId: existing.id });
  const student = await studentRepo.create(ctx, dto);
  await audit.record(ctx, "student.create", "student", student.id, null, student);
  events.emit("student.created", { ctx, student });       // worker may act (automations)
  return student;
}

// repository — the only Prisma importer; always tenant-scoped client
async function create(ctx: Ctx, dto: StudentCreateDTO) {
  return db(ctx).student.create({ data: { ...dto } });    // db(ctx) injects tenantId + sets RLS
}
```

---

## `packages/db`

```
packages/db/
├── prisma/
│   ├── schema.prisma            the models from DATABASE_SCHEMA.md
│   ├── migrations/              checked-in SQL migrations (incl. RLS policies)
│   └── seed.ts                  demo tenant, roles, sources, sample leads
├── src/
│   ├── client.ts                base PrismaClient (singleton)
│   ├── scoped.ts                db(ctx): tenant-scoped client extension (the security core)
│   └── raw.ts                   un-scoped client — importable ONLY by auth/ + super-admin/
└── index.ts
```

`scoped.ts` is where tenant isolation is implemented once: a Prisma client extension that,
for every tenant-owned model, (a) injects `where: { tenantId: ctx.tenantId }` on
read/update/delete, (b) forces `tenantId` on create, and (c) runs each operation in a
transaction that sets `app.tenant_id` for RLS. An ESLint rule (`no-restricted-imports`)
forbids importing `raw.ts` or `@prisma/client` anywhere except `packages/auth` and
`core/tenants` (super-admin paths).

---

## `apps/web`

```
apps/web/
├── app/
│   ├── (public)/login, forgot-password, reset-password/[token]
│   ├── (app)/                   authenticated tenant app (layout enforces session)
│   │   ├── dashboard/  leads/  followups/  web-leads/  reports/
│   │   ├── documents/ imports/ automations/ users/ audit/ settings/ account/
│   ├── (platform)/              super-admin tree (layout enforces SUPER_ADMIN)
│   └── api/                     route handlers (thin; call core services)
├── components/                  app-specific composition of packages/ui
├── lib/
│   ├── require-context.ts       auth + tenant + rate-limit gate for routes
│   ├── authorize.ts             wraps core policies for route use
│   └── api-client.ts            typed fetch wrapper (envelope-aware)
└── middleware.ts                session presence, security headers, CSP
```

Route handlers stay thin by rule: they may import services, validators, policies — and
are lint-blocked from importing repositories or Prisma.

---

## `apps/worker`

```
apps/worker/src/
├── queues/                      queue definitions (imports, exports, reminders, automations, comms)
├── processors/
│   ├── import.processor.ts      consumes core/imports service
│   ├── export.processor.ts
│   ├── reminder.processor.ts    follow-up overdue sweep + notifications
│   ├── automation.processor.ts  evaluates automation_rules on domain events
│   └── comms.processor.ts       outbound WhatsApp/email/SMS via core/communications
└── index.ts                     boots BullMQ workers; shares core + db
```

The worker imports the *same* `core` services — a CSV import called from the API and from
a retry both run one code path.

---

## Conventions enforced by tooling

| Rule | Enforced by |
|---|---|
| Only repositories import Prisma / the un-scoped client | ESLint `no-restricted-imports` |
| Routes don't import repositories | ESLint boundary rule (import zones) |
| Every input validated with Zod before the service | code review + route template |
| Policies are pure and covered by the RBAC matrix test | Vitest coverage gate on `*.policy.ts` |
| `tenantId` never read from request body | typed DTOs exclude it + runtime assert in `db(ctx)` |
| Consistent error envelope | `result.ts` helpers; routes return only `ok()`/`fail()` |
| Commits pass lint + typecheck + unit tests | CI + pre-push hook |

---

## Naming & file conventions

- Modules are singular-domain folders (`students/`, not `studentModule/`).
- Files are `name.layer.ts` (`student.service.ts`, `student.policy.ts`).
- Zod schemas end `Schema`; inferred types reuse `z.infer`.
- Domain events are `past-tense` (`student.created`, `followup.overdue`).
- Env vars validated once in `packages/config`; nothing reads `process.env` directly.

---

## Where later docs attach

- `SECURITY.md`, `AUDIT_LOGGING.md` → formalize what `shared/errors.ts`, `audit/`,
  `middleware.ts` implement.
- `IMPORT_EXPORT.md` → the `imports/` + `exports/` module behavior and the import wizard.
- `REPORTING.md` → the `reports/` queries + materialization.
- `AI_ROADMAP.md` → a future `ai/` module behind the same four-layer shape (lead scoring,
  call summaries, the CRM assistant), consuming `activities` and `reports`.
