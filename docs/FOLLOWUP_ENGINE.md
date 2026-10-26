# Follow-up engine — aVn CMS

> How calls are scheduled, queued, logged and escalated. Code: `packages/core/src/followups/followup.service.ts`,
> schemas in `packages/core/src/schemas.ts`, overdue sweep in `apps/worker`, escalation as an automation rule
> (`AUTOMATION.md`). Pages: Follow-ups (`/app/followups`), the lead's Follow-ups tab, the dashboard queue.

## 1. The model

A **follow-up** is one planned call (`follow_ups`): the lead, who makes it, when, a priority, and — once it has
happened — the outcome (`disposition`, a note, `completed_at`). A lead can have several open follow-ups; the earliest
open one is copied to `leads.next_call_at`, which drives "Today / Overdue" views and the workspace sort.

States, derived from the row:

| State | Condition |
|---|---|
| Open | `completed_at IS NULL` |
| Overdue | open and `scheduled_at` is before the start of today (agency time zone) — the queue bucket; `is_overdue` is the flag the worker sets once the slot has passed |
| Logged / closed | `completed_at` is set; it can no longer be edited or rescheduled |

## 2. Queue buckets

`GET /api/followups?bucket=…` returns, newest cursor first, only the caller's own calls for counselors and telecallers,
and anyone's (optionally one person's) for admins. The tab badges come from `queueCounts`.

| Bucket | Rule |
|---|---|
| `today` | open, scheduled within today (agency time zone) |
| `upcoming` | open, scheduled after today |
| `overdue` | open, scheduled before today |
| `pending` | every open call |
| `closed` | logged calls, newest first |

Calls of deleted leads never show (deleting a student closes their open calls, `STUDENT_LIFECYCLE.md`).

## 3. Scheduling

`POST /api/followups` with the lead, a time, an optional assignee, priority and note.

- The time must not be more than 5 minutes in the past.
- Who makes the call, if not stated: the lead's telecaller, otherwise the lead's counselor, otherwise the person
  scheduling. Counselors and telecallers can book a call for themselves or for the lead's own team; admins for anyone.
  The assignee must be an active admin, counselor or telecaller of the agency.
- Policy: `followup:schedule` with the lead's ownership (404 for a lead the person does not work).
- Writes an activity ("Call scheduled for …"), an audit row (`followup.schedule`) and recomputes `next_call_at`.

Rescheduling (`PATCH` with a new time) keeps the same row, clears the overdue flag and is audited
(`followup.reschedule`). A logged call cannot be rescheduled: book a new one.

## 4. Logging a call

`PATCH /api/followups/{id}` with a **disposition**:

| Disposition | Meaning | Counts as "spoke to someone" | May suggest stage |
|---|---|---|---|
| `COMPLETED` | Call done | yes | Contacted |
| `INTERESTED` | Wants to go ahead | yes | Interested |
| `NOT_INTERESTED` | Declined | yes | Not interested |
| `CALL_BACK_LATER` | Asked to be called again | yes | Follow-up required |
| `AWAITING_FEEDBACK` | Waiting on the family | yes | Follow-up required |
| `NO_ANSWER`, `BUSY`, `SWITCHED_OFF` | Not reached | no | — |
| `SCHEDULED`, `ESCALATED` | Initial state; set by escalation | — | — |

What logging does, in one transaction:

1. Marks the call completed with the disposition and note (a call already logged is refused with 409).
2. For a "spoke to someone" disposition, sets the lead's `last_contacted_at`.
3. Writes a `CALL` activity ("Call: No answer — …") and an audit row (`followup.log`).
4. **Suggests a stage, never applies one by itself.** The form offers the suggestion above; only when the person
   accepts (`applyStage`) and may change the stage (`lead:changeStage`) is the stage changed — through the same path as
   any stage change (history row, activity, audit, automation trigger).
5. Optionally books the **next call** (`nextCallAt`, must be in the future; same assignee and priority unless stated).
6. Recomputes `next_call_at`.

Telecallers log calls for their queue; they cannot change stage (RBAC: stage is counselor or admin).

## 5. Overdue and escalation

- **Overdue flag:** the worker's `overdue-sweep` (every 5 minutes) sets `is_overdue` on open calls whose time has
  passed. The queue itself does not depend on the flag: the Overdue bucket is computed from `scheduled_at`.
- **Escalation** is an automation rule, not hard-coded: trigger `FOLLOWUP_OVERDUE`, action `escalate`. It records
  `escalated_at` and `escalated_to` (the first admin) on the call, notifies the call's owner and the admins
  ("This call is 2 hours overdue"), and adds a line to the lead's timeline. A call that was made in the meantime, or
  already escalated, is skipped. The starter rule gives every agency one; how long to wait is the agency's choice
  (`AUTOMATION.md`). The automation sweep runs every 2 minutes, so an escalation can be about 2 minutes late.
- **Uncontacted leads** use the same machinery (trigger `LEAD_UNCONTACTED`, the agency's "uncontacted minutes").

## 6. Who sees what

| | Admin | Counselor | Telecaller |
|---|---|---|---|
| Queue | everyone's, filter by person | own | own |
| Schedule / reschedule / log | any | own leads' calls | own calls |
| Dashboard | agency-wide counts | own counts | own queue, completed today, callbacks due, no-answer rate |

Reports: calls, connected % and no-answer % per person (`REPORTING.md`).

## 7. At scale

The queue is a keyset-paginated read on `(tenant, assignee, scheduled_at)`; the agency-wide counts use the partial
indexes on open calls (`follow_ups_tenant_open`) and on finished calls (`follow_ups_done_idx`). Measured at 1M leads and
700k follow-ups: `SCALABILITY.md`.
