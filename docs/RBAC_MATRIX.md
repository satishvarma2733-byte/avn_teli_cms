# RBAC Permission Matrix

> Review item 3 of 6. Defines exactly what each role can do, to which resources, under
> which ownership conditions. This is the security surface: it is implemented as pure
> `policy` functions (`can(ctx, action, resource)`), unit-tested exhaustively, and checked
> at the service boundary on **every** mutating and listing endpoint — never only in the UI.

---

## Roles

| Role | Scope | One-line definition |
|---|---|---|
| **Super Admin** | Platform (all tenants) | Operates the SaaS: manages tenants, plans, platform analytics, billing. Reaches tenant data only via explicit, audited impersonation. |
| **Tenant Admin** (Agency Owner) | One tenant | Full control of their agency: users, all students/leads, reports, files, settings. |
| **Counselor** | Assigned leads within tenant | Works their assigned students end-to-end: updates stage, notes, schedules calls. |
| **Telecaller** | Assigned call queue within tenant | Runs the dialing queue: logs call outcomes, schedules callbacks, limited student data. |

The live product shows exactly these four (`SYSTEM ROLE` column: Super Admin, Tenant
Admin, Counselor, Telecaller) — the matrix below matches and then hardens them.

---

## Ownership conditions

Access within a tenant is narrowed by ownership, expressed as conditions the policy
evaluates against `TenantContext`:

- **`own`** — the acting user is the active assignee of the lead (counselor *or*
  telecaller assignment, per the action).
- **`tenant`** — any record in the caller's tenant.
- **`platform`** — any tenant (super admin only, via impersonation).
- **`self`** — the user's own account record.

---

## Matrix

Legend: ✅ full · 🟡 conditional (condition in cell) · ❌ none

| Resource / Action | Super Admin | Tenant Admin | Counselor | Telecaller |
|---|---|---|---|---|
| **Tenants** – create/suspend/configure | ✅ | ❌ | ❌ | ❌ |
| **Plans / Billing** – manage | ✅ | 🟡 view own tenant's plan & usage | ❌ | ❌ |
| **Impersonate tenant** (audited) | ✅ | ❌ | ❌ | ❌ |
| **Platform analytics** | ✅ | ❌ | ❌ | ❌ |
| **Users** – list | 🟡 platform | ✅ tenant | ❌ | ❌ |
| **Users** – create/edit/disable | 🟡 platform | ✅ tenant | ❌ | ❌ |
| **Users** – delete (with lead transfer) | 🟡 platform | ✅ tenant | ❌ | ❌ |
| **Users** – reset another's password | 🟡 platform | ✅ tenant | ❌ | ❌ |
| **Own account** – edit profile / password / MFA | ✅ self | ✅ self | ✅ self | ✅ self |
| **Students** – list | 🟡 platform | ✅ tenant | 🟡 own | 🟡 own (reduced fields) |
| **Students** – view detail | 🟡 platform | ✅ tenant | 🟡 own | 🟡 own (reduced fields) |
| **Students** – create | ❌ | ✅ tenant | ✅ (auto-assigned self or per rule) | ❌ |
| **Students** – edit contact data | ❌ | ✅ tenant | 🟡 own | 🟡 own (phone/alt only) |
| **Students** – delete / block | ❌ | ✅ tenant | ❌ | ❌ |
| **Students** – bulk reassign / bulk status | ❌ | ✅ tenant | ❌ | ❌ |
| **Leads** – change pipeline stage | ❌ | ✅ tenant | 🟡 own | ❌ |
| **Leads** – mark potential / HOT | ❌ | ✅ tenant | 🟡 own | 🟡 own |
| **Leads** – change counselor assignment | ❌ | ✅ tenant | ❌ | ❌ |
| **Leads** – change telecaller assignment | ❌ | ✅ tenant | 🟡 own (within own leads) | ❌ |
| **Follow-ups** – view queue | 🟡 platform | ✅ tenant | 🟡 own | 🟡 own |
| **Follow-ups** – schedule / reschedule | ❌ | ✅ tenant | 🟡 own | 🟡 own |
| **Follow-ups** – log disposition | ❌ | ✅ tenant | 🟡 own | 🟡 own |
| **Notes / Activities** – add | ❌ | ✅ tenant | 🟡 own | 🟡 own |
| **Activities** – view timeline | 🟡 platform | ✅ tenant | 🟡 own | 🟡 own (reduced) |
| **Web Leads** – view inbox | ❌ | ✅ tenant | 🟡 if routed to them | ❌ |
| **Web Leads** – convert / assign | ❌ | ✅ tenant | 🟡 assign self | ❌ |
| **Imports** – run CSV import | ❌ | ✅ tenant | ❌ | ❌ |
| **Exports** – export students/leads | 🟡 platform | ✅ tenant | 🟡 own only | 🟡 own only (reduced fields) |
| **Reports** – full reporting center | 🟡 platform agg | ✅ tenant | 🟡 own performance only | 🟡 own performance only |
| **Documents / Folders** – manage vault | ❌ | ✅ tenant | 🟡 student docs of own leads | ❌ |
| **Student doc checklist** – verify/reject | ❌ | ✅ tenant | 🟡 own | ❌ |
| **Automation rules** – manage | ❌ | ✅ tenant | ❌ | ❌ |
| **Audit log** – view | 🟡 platform | ✅ tenant | ❌ | ❌ |
| **Settings** – tenant settings | ❌ | ✅ tenant | ❌ | ❌ |
| **Intake credentials** – create / rotate / revoke (audited) | ❌ | ✅ tenant | ❌ | ❌ |
| **Intake credential** (machine caller) – create web lead | ❌ | ❌ | ❌ | ❌ |

> **Intake credentials are not users.** A credential can do exactly one thing — create a
> web lead in its own tenant through `/api/webleads` or `/api/public/*`. It cannot read
> anything and has no role in the matrix above.

> **Reduced fields for telecallers:** a telecaller's student view omits full address and
> email by default (they need name, phone, stage, next call, and call notes). This is a
> data-minimization choice; a tenant setting can widen it.

---

## Enforcement rules (non-negotiable)

1. **Every endpoint calls a policy.** List, read, create, update, delete, export — each
   runs `authorize(ctx, action, resource)` before the service touches data. There is no
   "UI hides the button so the API is safe" path.
2. **Tenant first, then role, then ownership.** A request is rejected at the first failing
   layer. A counselor requesting another counselor's lead by ID gets `404` (not `403`) so
   IDs aren't enumerable.
3. **Ownership is checked against the DB, not the request.** "Own" means "there is an
   active assignment row linking this user to this lead," verified server-side.
4. **No mass assignment.** Services accept validated DTOs; a counselor cannot flip
   `tenant_id`, `assignee_id`, or `role_code` by adding fields to a request body — those
   fields aren't in the DTO.
5. **Privilege changes are audited.** Role change, user disable, password reset,
   impersonation start/stop → `audit_logs` with old/new.
6. **Super Admin has no silent data access.** Reading tenant business data requires
   `actAsTenant(tenantId)` which (a) sets tenant context, (b) writes an audit row, (c)
   shows an "impersonating" banner. Platform analytics use pre-aggregated,
   non-PII rollups.

---

## Policy function shape (for implementation)

```ts
type Action =
  | "student:list" | "student:read" | "student:create" | "student:update"
  | "student:delete" | "student:bulkReassign"
  | "lead:changeStage" | "lead:assignCounselor" | "lead:assignTelecaller"
  | "followup:schedule" | "followup:logDisposition"
  | "webLead:convert" | "import:run" | "export:run"
  | "report:viewTenant" | "report:viewOwn"
  | "user:manage" | "automation:manage" | "audit:view" | /* … */;

interface Ctx { tenantId: string; userId: string; role: RoleCode; }

// pure, exhaustively unit-tested
function can(ctx: Ctx, action: Action, resource?: { tenantId: string; assigneeIds?: string[] }): boolean;
```

Ownership-sensitive actions receive the resource's `tenantId` + active `assigneeIds`;
`can` returns true only when tenant matches **and** (role grants `tenant` scope **or**
`ctx.userId ∈ assigneeIds`).

---

## Test obligations (block merges)

- A matrix-driven test iterates **every (role × action)** cell and asserts allow/deny.
- IDOR suite: each role attempts to read/update a record owned by another user and
  another tenant → expect `404`/`403`, never data.
- Mass-assignment suite: forbidden fields in bodies are ignored, not applied.
- Impersonation always produces an audit row.

See `docs/TEST_PLAN.md` (later phase) for the full suite.
