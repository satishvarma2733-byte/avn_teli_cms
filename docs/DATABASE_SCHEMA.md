# Database Schema

> Review item 2 of 6. PostgreSQL via Prisma. UUID primary keys, `tenant_id` on every
> tenant-owned table, timestamps everywhere, soft-delete where recovery matters, and
> explicit indexes for the hot query shapes. This is the contract the data layer builds
> against.

---

## Conventions

- **PK:** `id UUID DEFAULT gen_random_uuid()` (Postgres `pgcrypto`).
- **Tenancy:** every tenant-owned table has `tenant_id UUID NOT NULL REFERENCES tenants(id)`.
  `tenants`, `plans`, `roles` (global catalog) are the only non-tenant tables.
- **Timestamps:** `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at` auto-touched.
- **Soft delete:** `deleted_at TIMESTAMPTZ NULL` on `students`, `leads`, `users`,
  `documents`, `folders`. Queries filter `deleted_at IS NULL` by default. Hard delete only
  via a purge job.
- **Money:** integer minor units (paise) + `currency CHAR(3)`; never floats.
- **Phones:** stored raw **and** normalized (`phone_e164`) for dedupe/search.
- **Enums:** Postgres enums for closed sets (roles, stages, dispositions, sources).
- **RLS:** policies on tenant-owned tables (see Architecture §2); shown at the end.

---

## Entity-relationship overview

```
tenants ─┬─< users ─────< lead_assignments >──── leads >─── students
         │        └─< audit_logs                   │   │
         ├─< roles(global)                          │   ├─< lead_status_history
         ├─< lead_sources                           │   ├─< follow_ups ──< activities
         ├─< intake_credentials ──< web_leads       │   └─< notes
         ├─< web_leads ──(convert)──> students      │
         ├─< folders ──< documents                  │
         ├─< student_documents >── students         │
         ├─< import_jobs / export_jobs              │
         ├─< notifications                          │
         ├─< automation_rules                       │
         └─< subscriptions >── plans(global)        │
                                                    └─< activities (timeline)
```

---

## Core tables

### `tenants`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text | agency name (e.g. "eWings") |
| slug | text unique | subdomain / url key |
| status | enum(`ACTIVE`,`SUSPENDED`,`TRIAL`) | |
| plan_id | uuid fk → plans | current plan |
| settings | jsonb | timezone, locale, round-robin on/off, etc. |
| created_at / updated_at | timestamptz | |

### `plans` (global)
`id, code(STARTER|PROFESSIONAL|ULTRA|ENTERPRISE), name, limits jsonb (max_users, max_leads, storage_mb, automation_runs, comms_quota), price_minor, currency`.

### `subscriptions`
`id, tenant_id, plan_id, status(ACTIVE|PAST_DUE|CANCELED), period_start, period_end, created_at`. Usage counters live in `usage_counters (tenant_id, metric, period, value)` — billing stays loosely coupled from CRM logic.

### `roles` (global catalog)
`id, code(SUPER_ADMIN|TENANT_ADMIN|COUNSELOR|TELECALLER), name`. Permissions are code-defined (see `RBAC_MATRIX.md`), not rows, so the matrix is versioned with the app.

### `users`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| tenant_id | uuid fk | null only for SUPER_ADMIN (platform user) |
| role_code | enum | SUPER_ADMIN / TENANT_ADMIN / COUNSELOR / TELECALLER |
| name | text | |
| email | citext | **unique per tenant** (`UNIQUE(tenant_id, email)`) |
| phone_e164 | text null | |
| password_hash | text | Argon2id |
| status | enum(`ACTIVE`,`DISABLED`) | |
| mfa_secret | text null | TOTP, encrypted |
| last_login_at | timestamptz null | |
| created_at / updated_at / deleted_at | | |

> A departing user cannot be hard-deleted while owning leads — the service forces
> **transfer-on-delete** (reassign their leads) first. Enforced in `users` service +
> checked by FK `ON DELETE RESTRICT` on `lead_assignments.assignee_id`.

### `students` (the person)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| tenant_id | uuid fk | |
| name | text | |
| parent_name | text null | father/mother |
| phone_raw | text | as entered |
| phone_e164 | text | normalized; dedupe key |
| alt_phone_e164 | text null | |
| email | citext null | |
| town | text null | |
| district | text null | |
| state | text null | |
| address | text null | |
| created_at / updated_at / deleted_at | | |

**Dedupe:** partial unique index `UNIQUE(tenant_id, phone_e164) WHERE deleted_at IS NULL`.
Email is a soft dedupe signal (surfaced to the user), not a hard constraint, because
shared family emails are common.

### `lead_sources`
`id, tenant_id, code, label` — seeded from what the live product uses:
`SHEET_DATA, GOOGLE_ADS, META_ADS, DIRECT_CALL, REFERENCE, WEBSITE, WALK_IN, OTHER`.
Per-tenant so agencies can add their own. ROI reporting groups on this.

### `leads` (the opportunity)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| tenant_id | uuid fk | |
| student_id | uuid fk → students | |
| source_id | uuid fk → lead_sources | |
| stage | enum `lead_stage` | see §Pipeline enum |
| is_potential | boolean default false | the "Potential Lead" marker |
| priority | enum(`NORMAL`,`HOT`) default NORMAL | the HOT tag |
| interest_country | text null | e.g. Kyrgyzstan, Georgia (free text / tag) |
| interest_course | text null | e.g. MBBS |
| next_call_at | timestamptz null | drives the follow-up queue |
| lost_reason | text null | when stage is a negative terminal |
| created_at / updated_at / deleted_at | | |

### `lead_assignments`
Who owns a lead, by function. One active row per (lead, role_function).
`id, tenant_id, lead_id, assignee_id → users, role_function(COUNSELOR|TELECALLER), assigned_by, assigned_at, is_active`. History is retained (old rows `is_active=false`) so reassignments are auditable and "who had this lead in March" is answerable.

### `lead_status_history`
Append-only; every stage change.
`id, tenant_id, lead_id, from_stage, to_stage, changed_by, note, reason, created_at`.

### `follow_ups`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| tenant_id | uuid fk | |
| lead_id | uuid fk | |
| scheduled_at | timestamptz | the call slot |
| assignee_id | uuid fk → users | the caller |
| disposition | enum `call_disposition` | see §Disposition enum |
| priority | enum(`NORMAL`,`HOT`) | |
| outcome_note | text null | |
| completed_at | timestamptz null | |
| is_overdue | boolean (derived/maintained) | sweep job sets it |
| escalated_to | uuid null → users | auto-escalation target |
| created_at / updated_at | | |

### `activities` (the timeline — the biggest gap we're fixing)
Append-only, polymorphic by `type`. One unified feed per lead/student.
`id, tenant_id, lead_id null, student_id, type(CALL|WHATSAPP|EMAIL|SMS|NOTE|STATUS_CHANGE|ASSIGNMENT|DOCUMENT|SYSTEM), actor_id null, channel null, direction(IN|OUT) null, summary text, payload jsonb, created_at`. Calls, messages, status changes and notes all land here, giving the "what was said on the last 4 calls" view the original lacks.

### `notes`
Lightweight free-text notes also mirrored into `activities`; kept as its own table for quick lead-level listing. `id, tenant_id, lead_id, author_id, body, created_at`.

---

## Intake, documents, jobs

### `web_leads`
Raw external submissions, before they become a student/lead.
`id, tenant_id, name, phone_raw, phone_e164, email, interest_country, interest_course, message, source_id, submitted_at, status(NEW|DUPLICATE|CONVERTED|SPAM|REJECTED), dedupe_match_student_id null, converted_lead_id null, raw_payload jsonb, created_at`.
Index on `(tenant_id, status, submitted_at desc)`; `phone_e164` checked against `students` on insert to set `DUPLICATE` + `dedupe_match_student_id`.

**Compatibility and attribution columns** (all nullable; filled by the LeadXP-compatible
`/api/webleads` adapter and by any sender that supplies them — see
[`WEBLEADS_COMPATIBILITY.md`](WEBLEADS_COMPATIBILITY.md)):
`intake_channel enum(PUBLIC_API|WEBHOOK|LEADXP_COMPAT|IMPORT)`, `intake_credential_id → intake_credentials`,
`source_label text` (the sender's original source string; `source_id` is the resolved code),
`city, neet_score int, neet_status, education, education_group, submitted_by (parent/student), post_slug`,
`gclid, campaign_id, page_url, landing_page, utm_source, utm_medium, utm_campaign, utm_term, utm_content, form_id, session_id`,
`quality_flags text[]` (e.g. `INVALID_EMAIL`), `idempotency_key text`.
`raw_payload` always holds the full body as received, so nothing a sender posts is lost
even before a column exists for it. Partial unique index
`UNIQUE(tenant_id, intake_credential_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.

### `intake_credentials`
Tenant-scoped credentials for unauthenticated intake routes (`/api/webleads`,
`/api/public/web-leads`, `/api/public/webhooks/leads`). The credential, not the request
body, decides the tenant.
`id, tenant_id, name, username text unique (public), secret_hash text (SHA-256; secret shown once), previous_secret_hash null + previous_valid_until null (rotation overlap), default_source_id null → lead_sources, rate_limit_per_min int default 120, last_used_at null, use_count bigint default 0, created_by, created_at, revoked_at null`.
Create / rotate / revoke are audited.

### `folders`
`id, tenant_id, name, parent_id null, created_by, created_at, deleted_at`. (The "Educational Folders Vault" — e.g. "admissions 2026".)

### `documents`
`id, tenant_id, folder_id null, student_id null, series_id, doc_type null, filename, mime_type, size_bytes, storage_key, scan_status(PENDING|CLEAN|INFECTED|REJECTED), scan_signature null, scan_attempts, scan_error null, scanned_at null, uploaded_at null, version int, uploaded_by, created_at, deleted_at null, purged_at null`. The bytes live in Cloudflare R2 under `storage_key` (`tenants/<tenant>/documents/<id>`). Every version of one document is a row; versions share `series_id` (the first version’s own id) and `(tenant_id, series_id, version)` is unique. `uploaded_at` is null until the browser’s upload is confirmed; `scan_status` is PENDING until the antivirus has spoken, and only CLEAN files are served, only through signed, expiring URLs (`DOCUMENTS.md`). `purged_at` marks when the stored object was removed.

### `student_documents` (checklist)
Per-student required-doc tracking.
`id, tenant_id, student_id, doc_type(PASSPORT|MARKS_MEMO|NEET_RESULT|TRANSFER_CERT|PHOTO|ADMISSION_LETTER|VISA|PAYMENT_RECEIPT|OTHER), document_id null → documents, status(MISSING|UPLOADED|VERIFIED|REJECTED), reviewed_by null, note null, updated_at`.

### `import_jobs` / `export_jobs`
`id, tenant_id, requested_by, type, status(DRAFT|VALIDATING|VALIDATED|QUEUED|RUNNING|DONE|FAILED|CANCELED; exports use QUEUED|RUNNING|DONE|FAILED), params jsonb, result jsonb (counts, error_report_key), file_key, created_at, finished_at, heartbeat_at`. Imports record mapping, dedupe choice, and a downloadable per-row error report. `heartbeat_at` is the last sign of life of a claimed job (set when it is claimed, renewed after each batch or page); the worker's stuck-jobs sweep fails a VALIDATING/RUNNING job whose heartbeat is over 10 minutes old (`IMPORT_EXPORT.md` §7).

---

## Platform tables

### `notifications`
`id, tenant_id, user_id, type, title, body, entity_type, entity_id, read_at null, created_at`.

### `automation_rules`
`id, tenant_id, name, is_active, trigger(WEB_LEAD_CREATED|LEAD_UNCONTACTED|FOLLOWUP_OVERDUE|STAGE_CHANGED|…), conditions jsonb, actions jsonb (assign_round_robin|notify|escalate|schedule_followup|stop_reminders), created_by, created_at`. Evaluated by the worker.

### `audit_logs`
`id, tenant_id, user_id, action, entity_type, entity_id, old_value jsonb, new_value jsonb, ip inet, user_agent text, impersonated_by uuid null, created_at`. Write-only from services; viewer is admin-only. Full action list in `AUDIT_LOGGING.md`.

---

## Pipeline enum (`lead_stage`)

```
NEW, CONTACTED, INTERESTED, FOLLOW_UP_REQUIRED, POTENTIAL,
APPLICATION_STARTED, DOCUMENTS_PENDING, APPLICATION_SUBMITTED,
OFFER_RECEIVED, ADMISSION_CONFIRMED, ENROLLED,          -- positive path
NOT_INTERESTED, INVALID, UNREACHABLE, DUPLICATE, BLOCKED, LOST,  -- negative/terminal
LONG_TERM                                               -- parked
```

## Disposition enum (`call_disposition`)

```
SCHEDULED, COMPLETED, NO_ANSWER, BUSY, SWITCHED_OFF,
CALL_BACK_LATER, INTERESTED, NOT_INTERESTED, AWAITING_FEEDBACK, ESCALATED
```

> The live product's observed values (`Long Term`, `Not Enrolled`, `Contacted`,
> `Interested`, `Follow-up Required`, `Awaiting Feedback`) all map cleanly:
> stage-like ones → `lead_stage`, call-like ones → `call_disposition`. A migration map
> will be in `IMPORT_EXPORT.md` so existing data lands in the right field.

---

## Indexes (the hot paths)

| Table | Index | Serves |
|---|---|---|
| students | `UNIQUE(tenant_id, phone_e164) WHERE deleted_at IS NULL` | dedupe |
| students | `(tenant_id, name) gin_trgm`, `(tenant_id, phone_e164)`, `(tenant_id, email)` | search |
| students | `(tenant_id, state, district)` | geo filters |
| leads | `(tenant_id, stage)` | status filter + dashboard counts |
| leads | `(tenant_id, is_potential) WHERE is_potential` | potential leads card |
| leads | `(tenant_id, priority) WHERE priority='HOT'` | hot leads |
| leads | `(tenant_id, created_at desc, id)` | keyset pagination |
| lead_assignments | `(tenant_id, assignee_id, is_active)` | "my leads", reassignment |
| follow_ups | `(tenant_id, assignee_id, scheduled_at)` | per-caller daily queue |
| follow_ups | `(tenant_id, scheduled_at) WHERE completed_at IS NULL` | Today/Upcoming/Pending/Overdue |
| lead_status_history | `(tenant_id, lead_id, created_at)` | lead timeline |
| activities | `(tenant_id, student_id, created_at desc)` | timeline feed |
| web_leads | `(tenant_id, status, submitted_at desc)`, `(tenant_id, phone_e164)` | inbox + dedupe |
| web_leads | `(tenant_id, utm_campaign)`, `(tenant_id, source_label)` | attribution reports |
| intake_credentials | `UNIQUE(username)`, `(tenant_id) WHERE revoked_at IS NULL` | intake auth lookup |
| audit_logs | `(tenant_id, entity_type, entity_id, created_at desc)` | entity audit view |

---

## Prisma sketch (abridged)

```prisma
model Tenant {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  slug      String   @unique
  status    TenantStatus @default(TRIAL)
  planId    String?  @db.Uuid
  settings  Json     @default("{}")
  users     User[]
  students  Student[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Student {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  tenant      Tenant   @relation(fields: [tenantId], references: [id])
  name        String
  parentName  String?
  phoneRaw    String
  phoneE164   String
  altPhoneE164 String?
  email       String?
  town        String?
  district    String?
  state       String?
  address     String?
  leads       Lead[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?
  @@unique([tenantId, phoneE164])
  @@index([tenantId, state, district])
}

model Lead {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @db.Uuid
  studentId     String   @db.Uuid
  student       Student  @relation(fields: [studentId], references: [id])
  sourceId      String   @db.Uuid
  stage         LeadStage @default(NEW)
  isPotential   Boolean  @default(false)
  priority      Priority @default(NORMAL)
  interestCountry String?
  interestCourse  String?
  nextCallAt    DateTime?
  assignments   LeadAssignment[]
  followUps     FollowUp[]
  statusHistory LeadStatusHistory[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  @@index([tenantId, stage])
  @@index([tenantId, createdAt, id])
}
// … remaining models follow the tables above
```

---

## Row-Level Security (backstop)

```sql
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON students
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- repeated for every tenant-owned table; app sets app.tenant_id per transaction.
```

The app-level tenant-scoped Prisma client is primary; RLS guarantees that even a
mistaken query cannot cross tenants. Super-admin paths run with a role that bypasses RLS
and are always audited with `impersonated_by`.
