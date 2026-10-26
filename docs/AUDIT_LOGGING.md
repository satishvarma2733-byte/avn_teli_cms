# Audit logging — aVn CMS

> What is recorded, where, who can read it, and what keeps it honest. Code: `packages/core/src/shared/audit.ts`
> (the writer), `packages/core/src/audit/audit.service.ts` (the viewer), `packages/auth/src/audit.ts` (sign-in events).
> Related: `SECURITY.md` §2.3, `RBAC_MATRIX.md`.

## 1. Three records, three jobs

| Record | Table | Question it answers | Who reads it |
|---|---|---|---|
| **Audit log** | `audit_logs` | Who changed what, from where, and what was it before? | Agency admins (Settings → Audit log); platform staff for platform actions |
| **Activity timeline** | `activities` | What happened with this student? (calls, notes, stage changes, assignments, documents) | Everyone who can open the lead, within their scope |
| **Stage history** | `lead_status_history` | Which stages did this lead pass through, when, and why? | Feeds the conversion funnel (`REPORTING.md`) and the timeline |

All three are written **in the same database transaction as the change they describe**, so there is never a change
without its record, or a record of a change that rolled back.

## 2. What an audit row holds

`id`, `tenant_id` (null for platform-level actions), `user_id` (the person acting; null for the system), `action`,
`entity_type`, `entity_id`, `old_value` and `new_value` (JSON snapshots, so the row can answer "what was it before"),
`ip` (the address our own proxy saw, `SECURITY.md` §2.2), `user_agent` (cut to 300 characters),
`impersonated_by` (the platform admin, when a super admin was acting inside an agency) and `created_at`.

BigInt values are written as text. Passwords, hashes, tokens, secrets and recovery codes are never put in a snapshot;
intake credentials are logged by name and username only (the secret is shown once, at creation or rotation).

## 3. What is recorded

| Area | Actions |
|---|---|
| Sign-in and account | `auth.login`, `auth.logout`, `auth.password_changed`, `auth.password_reset_requested`, `auth.password_reset`, `auth.mfa_enabled`, `auth.mfa_disabled`, `auth.mfa_recovery_regenerated`, `auth.mfa_recovery_used`, `auth.sessions_revoked`, plus lock-outs (`auth.locked`, `auth.mfa_locked`) |
| Students and leads | `student.create`, `student.update`, `student.delete`, `lead.update`, `lead.stage_change`, `lead.assign`, `note.create` |
| Follow-ups | `followup.schedule`, `followup.reschedule`, `followup.log` |
| Web leads | `web_lead.status`, `web_lead.convert`, `intake_credential.create`, `intake_credential.rotate`, `intake_credential.revoke` |
| People | `user.create`, `user.role_change`, `user.delete`, `user.password_reset_by_admin`, `user.transfer_leads` |
| Settings | `settings.update`, `source.create`, `source.update` |
| Imports and exports | `import.upload`, `import.start`, `import.run`, `import.cancel`, `export.requested`, `export.run`, `export.downloaded`, `file.downloaded` |
| Documents | `folder.created`, `folder.renamed`, `folder.deleted`, `document.upload_started`, `document.uploaded`, `document.reviewed`, `document.rejected`, `document.rescan_requested`, `document.downloaded`, `document.deleted` |
| Automation | `automation.created`, `automation.updated`, `automation.deleted`, `automation.starter_installed` (each run has its own log, `AUTOMATION.md`) |
| Platform | `platform.tenant_create`, `platform.tenant_status`, `platform.tenant_plan`, `platform.impersonation_start`, `platform.impersonation_stop` |

Reads are not audited, with two deliberate exceptions: **downloads** (a signed link for a document or export is
audited when it is issued, `DOCUMENTS.md`) and **impersonation** (start and stop). A super admin who reads an
agency's data does it only through impersonation, so that data access is always on the record, with
`impersonated_by` set on every row written during the session.

## 4. Reading it

- **Agency admins:** Settings → Audit log, or `GET /api/audit`, newest first, 50 per page, with filters for action
  (prefix, so `auth.` shows every sign-in event), entity type, entity id, person, and a date range in the agency's
  time zone. The viewer shows names, not ids, and names the platform admin on rows written while they were
  impersonating. Policy action `audit:view` (admins only).
- **Platform staff:** `platform.platformAudit` (platform actions and cross-agency events), super admin only.
- **Counselors and telecallers** cannot open the audit log. They see the activity timeline of the leads they work.

## 5. What keeps it honest

- **Append-only for the application.** The database role the app runs as (`avn_app`) has `SELECT, INSERT` on
  `audit_logs`, `activities` and `lead_status_history` and nothing else: it cannot update or delete a row, even
  through a bug or an injected query. A test attempts both as the application role and expects the database to refuse.
- **Tenant-scoped.** Row-level security limits each agency to its own rows; the sign-in and platform writers use the
  owner connection and always set `tenant_id` explicitly.
- **Same transaction.** See above: a change and its record commit together.
- **Retention.** Audit rows are kept indefinitely (they are small and indexed by `(tenant_id, created_at)` and by
  `(tenant_id, entity_type, entity_id, created_at)`). Archiving old rows to cold storage is on the roadmap
  (`IMPROVEMENT_ROADMAP.md`). The viewer reads by keyset on `(tenant_id, created_at)`, so its cost does not grow with
  the size of the log (measured: `SCALABILITY.md` §5).

## 6. Adding an audited action

Call `audit(db, ctx, 'area.action', 'entity_type', entityId, before, after)` inside the service's transaction, with
snapshots that contain only what a reader needs (ids, names, the fields that changed). Name actions
`<noun>.<verb>`. Add the name to the table above; the audit viewer's prefix filter needs no change.
