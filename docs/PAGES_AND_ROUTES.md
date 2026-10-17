# Pages & Routes

> Review item 4 of 6. The full page tree (what each role sees), the URL structure, and
> the API route list. Pages are gated by role; the gating mirrors
> [`RBAC_MATRIX.md`](RBAC_MATRIX.md) and is enforced server-side, not by hiding links.

---

## URL structure

Tenancy is derived from the session, so URLs are **not** tenant-prefixed for normal
users (cleaner, and prevents tenant-id tampering in the path). Super Admin lives under a
separate `/platform` tree.

```
/login                      public
/forgot-password            public
/reset-password/[token]     public

/                           → role-aware redirect (dashboard)
/app/*                      authenticated tenant app
/platform/*                 super-admin only
/api/*                      JSON API
/api/public/*               unauthenticated intake (web-lead webhook) — API key + rate limited
/api/webleads               LeadXP-compatible intake (same path as the live product) — Basic auth + rate limited
```

---

## Page tree — Tenant app (`/app`)

Visibility per role shown as `[A]` Tenant Admin · `[C]` Counselor · `[T]` Telecaller.

```
/app
├── /dashboard                      [A][C][T]  role-specific cards + follow-up queue
│
├── /leads                          [A][C][T]  Student/Lead workspace (the big table)
│   ├── ?view=all|mine|today|…               saved filters, server-driven
│   ├── /new                        [A][C]    Add Student form
│   └── /[leadId]                    [A][C][T] Lead detail
│        ├── (overview)                        contact, stage, assignment, potential/HOT
│        ├── (timeline)                        activities feed  ← the new history view
│        ├── (followups)                       scheduled + past calls, dispositions
│        ├── (documents)                       student doc checklist
│        └── (notes)
│
├── /followups                      [A][C][T]  Call queue: Today | Upcoming | Pending | Overdue | Closed
│
├── /web-leads                      [A][C]     External intake inbox (a counselor sees the ones routed to them)
│   └── /[webLeadId]                 [A]        review → convert / mark duplicate / assign
│
├── /reports                        [A][C*][T*] *own-performance-only for C/T
│   ├── /funnel                      [A]        conversion funnel
│   ├── /sources                     [A]        source ROI
│   ├── /team                        [A]        counselor & telecaller leaderboard
│   ├── /status                      [A]        stage distribution
│   ├── /followups                   [A]        follow-up performance / overdue
│   └── /me                          [C][T]     own numbers
│
├── /documents                      [A]        Folder vault: the agency's own files (?folder=<id> opens a folder)
│
├── /imports                        [A]        CSV/XLSX import wizard + history
│   ├── /new                         [A]        upload a file (step 1)
│   └── /[id]                        [A]        map columns, check, import, results
├── /exports                        [A][C][T]  your exports and their download links
│
├── /automations                    [A]        rules (builder dialog) + run log
├── /notifications                  [A][C][T]  your notifications, unread badge in the navigation
│
├── /users                          [A]        Users workspace (team)
│   ├── /new                         [A]
│   └── /[userId]                    [A]        edit, reset pw, transfer leads, deactivate
│
├── /audit                          [A]        audit log viewer
│
├── /settings                       [A]        tenant settings (sources, round-robin, checklist, comms)
│   └── /integrations                [A]        web-lead credentials (create / rotate / revoke), source mapping
│
└── /account                        [A][C][T]  My Account: profile, password, MFA, sessions
```

### Role landing / scope summary

| Role | Lands on | Sees in nav |
|---|---|---|
| Tenant Admin | `/app/dashboard` (full) | everything above |
| Counselor | `/app/dashboard` (own) | leads(own), followups(own), reports/me, account |
| Telecaller | `/app/followups` (own queue) | followups(own), leads(own, reduced), reports/me, account |

---

## Page tree — Platform (`/platform`, Super Admin only)

```
/platform
├── /dashboard          platform KPIs (tenants, MRR, usage) — aggregated, non-PII
├── /tenants            list / create / suspend
│   └── /[tenantId]     plan, usage, settings, [Impersonate] (audited)
├── /plans              plan catalog + limits
├── /billing            subscriptions, invoices, usage
├── /audit              platform-wide audit (incl. impersonations)
└── /account
```

---

## Dashboard composition (per role)

Mirrors the live cards and improves them.

**Tenant Admin** — cards: Total Active Leads · Calls Scheduled Today · Potential Leads ·
Enrolled · **Overdue Follow-ups (new)**. Below: conversion funnel, source-ROI mini,
team leaderboard, recent activity, the Today/Upcoming/Pending/Closed queue.

**Counselor** — cards: My Active Leads · My Calls Today · My Potential · My Enrolled ·
My Overdue. Below: my follow-up queue, my recent activity.

**Telecaller** — cards: My Queue Today · Completed Today · Callbacks Due · My No-Answer
rate. Below: the dialing queue with click-to-call.

---

## API routes

REST under `/api`. All list endpoints: cursor pagination (`?cursor=&limit=`), filtering,
sorting (`?sort=`), search (`?q=`). All responses use the envelope in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §3.

### Auth
```
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/auth/forgot-password
POST   /api/auth/reset-password
POST   /api/auth/mfa/enroll        POST /api/auth/mfa/verify
GET    /api/auth/sessions          DELETE /api/auth/sessions/:id   (logout other devices)
```

### Students & leads
```
GET    /api/students               ?q&stage&source&counselor&telecaller&state&district&cursor&limit&sort
POST   /api/students
GET    /api/students/:id
PATCH  /api/students/:id
DELETE /api/students/:id           (soft; admin)
POST   /api/students/bulk          { action: reassign|setStage|block, ids[], payload }  (admin)

GET    /api/leads/:id
PATCH  /api/leads/:id              (stage, potential, priority, assignment — policy-gated)
GET    /api/leads/:id/timeline     activities feed (cursor)
GET    /api/leads/:id/history      status history
POST   /api/leads/:id/notes
```

### Follow-ups
```
GET    /api/followups              ?bucket=today|upcoming|pending|overdue|closed&assignee&cursor
POST   /api/followups              schedule
PATCH  /api/followups/:id          reschedule / log disposition / complete
```

### Web leads
```
GET    /api/web-leads              ?status&source&q&cursor
POST   /api/web-leads/:id/convert  → creates/links student + lead, assigns
PATCH  /api/web-leads/:id          status (duplicate/spam/rejected)
POST   /api/public/web-leads       public intake (API key, rate-limited, Zod-validated)
POST   /api/public/webhooks/leads  generic landing-page webhook
POST   /api/webleads               LeadXP-compatible intake: accepts the live product's payloads unchanged
                                   (Basic auth via intake credential; see WEBLEADS_COMPATIBILITY.md)

GET    /api/settings/intake-credentials           list (no secrets)
POST   /api/settings/intake-credentials           create → secret shown once
POST   /api/settings/intake-credentials/:id/rotate
DELETE /api/settings/intake-credentials/:id       revoke
```

The three intake routes share one `webLeads` service; `/api/webleads` is only a
field-normalising adapter in front of it.

### Import / export
```
POST   /api/imports                upload → returns job id
GET    /api/imports                your workspace's imports (newest first)
GET    /api/imports/:id            status, check results, error report link
POST   /api/imports/:id/validate   confirm the column mapping and run the check (202)
POST   /api/imports/:id/run        start the import with a duplicate mode (202)
DELETE /api/imports/:id            cancel before the run starts
POST   /api/exports                { entity, filters, format: csv|xlsx|pdf } → job id
GET    /api/exports                your exports (newest 20)
GET    /api/exports/:id            status; a fresh download link when ready
GET    /api/files/:id              signed download (exp, sig); 410 once expired
GET    /api/students/template      downloadable CSV template
```

### Reports
```
GET    /api/reports/dashboard      role-aware KPI bundle
GET    /api/reports/funnel         ?dateFrom&dateTo&source&state
GET    /api/reports/sources        source ROI
GET    /api/reports/team           counselor/telecaller performance
GET    /api/reports/status         stage distribution
GET    /api/reports/followups      follow-up stats
```

### Documents
```
GET    /api/folders                sub-folders + path (admins); POST create
PATCH  /api/folders/:id            rename; DELETE only when empty
GET    /api/documents              files in a folder, or a search (admins)
POST   /api/documents              start an upload → presigned PUT URL (201)
POST   /api/documents/:id/complete confirm the upload, queue the virus scan
GET    /api/documents/:id          the document and its versions
GET    /api/documents/:id/url      signed download URL (5 min); 409 until the scan is clean; audited
DELETE /api/documents/:id          remove every version
GET    /api/documents/stuck        files whose virus scan did not finish (admins)
POST   /api/documents/:id/rescan   scan such a file again (admins; audited)
GET    /api/students/:id/documents the checklist + other documents
PATCH  /api/students/:id/documents/:docType   verify / reject / un-verify an item
```

### Users / admin
```
GET    /api/users                  POST /api/users
GET    /api/users/:id              PATCH /api/users/:id   DELETE /api/users/:id (requires lead transfer)
POST   /api/users/:id/reset-password
POST   /api/users/:id/transfer-leads  { toUserId }
GET    /api/automations            POST /api/automations  PATCH /api/automations/:id  DELETE /api/automations/:id
POST   /api/automations/starter    add the missing starter rules
GET    /api/automations/runs       run log (?ruleId&status&cursor&limit)
GET    /api/notifications          my notifications (?unreadOnly&cursor&limit)   GET /api/notifications/unread
POST   /api/notifications/read     { ids } or { all: true }
GET    /api/audit                  ?entityType&entityId&actor&dateFrom&dateTo&cursor
GET    /api/settings               PATCH /api/settings
```

### Platform (super admin)
```
GET    /api/platform/tenants       POST /api/platform/tenants  PATCH /api/platform/tenants/:id
POST   /api/platform/tenants/:id/impersonate   (audited; returns scoped session)
GET    /api/platform/plans         GET /api/platform/metrics
```

---

## Cross-cutting UI (every authenticated page)

- **Global search** (⌘K command palette): jump to a student by name/phone, run a saved
  filter, or trigger an action — replacing the live product's per-page-only search.
- **Sticky table headers**, column chooser, saved filters, bulk-action bar.
- **Optimistic updates** on inline stage/assignment changes with rollback on error.
- **Role-aware nav** rendered from the same policy module that gates the API, so UI and
  API can never disagree about what a role may do.
