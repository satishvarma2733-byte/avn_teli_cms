# Student lifecycle — aVn CMS

> From first enquiry to enrolment (or closure): the objects, the stages, who may move a lead, and what every move
> leaves behind. Code: `packages/core/src/leads/`, `webLeads/`, `imports/`. Pages: `PAGES_AND_ROUTES.md`.

## 1. Student, lead, enquiry

| Object | What it is | Identity |
|---|---|---|
| **Web lead** | A raw enquiry from a website, kept as it arrived (`web_leads`) | Idempotency key per submission |
| **Student** | The person (`students`): name, parent, phone, email, place | **Phone number**, normalised to E.164, unique among a workspace's live students |
| **Lead** | One admission opportunity for that student (`leads`): stage, source, priority, interest, assignments | A student can have several leads over time; the entry points reuse the open one rather than open a second |

Email is a soft signal: a second student with the same email is flagged ("possible duplicate"), never blocked.

## 2. Ways a student comes in

1. **Add Student** (`POST /api/students`): a counselor adds themselves as the owner; an admin may pick the counselor
   and telecaller. A phone number that already belongs to a student is refused with 409 and the existing student's id,
   so the person can open them instead (counselors see the name only if their role may read students).
2. **Website enquiry** (`POST /api/webleads` and the public endpoints, `WEBLEADS_COMPATIBILITY.md`): lands in the
   **Web leads** inbox as `NEW`, or `DUPLICATE` when the phone matches a live student. Enquiries are never refused for
   plan limits, so no website lead is lost. Round-robin routing to a counselor is an automation rule (`AUTOMATION.md`).
3. **Convert** (`POST /api/web-leads/{id}/convert`): creates the student and a `NEW` lead, or — if the phone belongs to
   a student who has an open lead — adds an "Enquired again via …" entry to that lead's timeline instead of a second
   lead. If the student's leads are all closed, a new lead is opened for them. Counselors can only take a web lead
   routed to them and only for themselves.
4. **Import** (`/app/imports`, `IMPORT_EXPORT.md`): CSV or XLSX through a dry run first; duplicates by phone follow the
   chosen mode — `skip`, `update` (overwrite) or `merge` (fill what is empty).

Every new lead gets a stage-history row (`NEW`, no previous stage), a timeline entry ("Student added (source: …)")
and an audit row. A new lead counts against the plan's lead limit (`SCALABILITY.md` §7).

## 3. Stages

Eighteen stages, in three groups:

| Group | Stages |
|---|---|
| **Progress** (the funnel) | New → Contacted → Interested → Follow-up required → Potential → Application started → Documents pending → Application submitted → Offer received → Admission confirmed → **Enrolled** |
| **Closed, not converted** | Not interested, Invalid, Unreachable, Duplicate, Blocked, Lost |
| **Parked** | Long term |

- **Active** = not Enrolled and not one of the six closed stages. Dashboards count active leads this way.
- Stages are labels, not a gate: a lead can be moved to any stage (the funnel report counts a lead as having reached
  the furthest stage it ever held, so skipping a stage does not break the numbers).
- Closing a lead (any closed stage except Duplicate) requires a reason (`lostReason`) or a note.
- `Potential` and `HOT` are separate markers (`is_potential`, `priority`), not stages: they can be set on any lead and
  filtered on any list.

## 4. Changing a stage

`PATCH /api/leads/{id}` with `stage` (admin, or the counselor who owns the lead; telecallers cannot). In one
transaction: the lead is updated (`last_contacted_at` is set when it leaves New), a **stage-history** row records
from → to, who, the note and the reason, a `STATUS_CHANGE` activity is added to the timeline, an audit row
(`lead.stage_change`) keeps the before and after, and automation rules for "stage changed" are queued after the commit
(for example Enrolled stops reminders; Interested books a follow-up).

A call can **suggest** a stage (`FOLLOWUP_ENGINE.md` §4); the person confirms it.

## 5. Ownership and assignment

A lead has at most one active **counselor** and one active **telecaller** (`lead_assignments`, one active row per
role function; the history of earlier assignees is kept). "Own" in the permission matrix means "has the active
assignment" and is checked in the database on every request (`RBAC_MATRIX.md`).

- Admins assign or change either role; a counselor can assign a telecaller within their own leads.
- The agency setting **round robin** assigns new students to counselors in turn.
- Bulk actions (admin, `POST /api/students/bulk`): reassign, set stage, block. Block moves the lead to Blocked.
- A person who still has leads or open calls cannot be deleted. `POST /api/users/{id}/transfer-leads` moves their
  active assignments and open calls to a colleague (audited), after which the deletion goes through.

## 6. What a lead's page shows

Overview (contact details, stage, priority, interest, source, assignees), **Timeline** (calls, notes, stage changes,
assignments, documents and system events, newest first), **Follow-ups**, **Documents** (the per-student checklist,
`DOCUMENTS.md`) and **Notes**. Telecallers see a reduced set of contact fields (name, phone, stage, next call, notes);
address and email are hidden by the same rule in lists, search and exports.

## 7. Closing the loop

- **Enrolled:** the lead leaves the active counts and the funnel's last bar; automation stops its reminders.
- **Lost, not interested, etc.:** the reason is on the history row and in reports by source.
- **Deleting a student** (admin) is a soft delete: the student, all their leads are marked deleted, their open
  follow-ups are closed with the note "Closed: student deleted", and the audit row keeps the name and phone. Deleted
  records disappear from lists, search, queues and reports, and their phone number can be used again.
- **Coming back:** a returning enquirer whose leads are all closed gets a new lead on the same student, with the old
  history still on the student's timeline.
