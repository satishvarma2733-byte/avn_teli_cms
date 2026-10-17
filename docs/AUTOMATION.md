# Automation (Phase 8)

Rules that run the busywork. A rule says: **when** something happens, **if** it fits the
conditions, **do** these actions. Admins build and switch rules on the Automations page
(`/app/automations`); everything a rule does is written to a run log. Everyone is told what
happened to them in their notification inbox (`/app/notifications`).

Code: `avn_cms/packages/core/src/automation/` and `…/notifications/`; screens in
`avn_cms/apps/web/src/app/(app)/app/{automations,notifications}`; the sweep in
`avn_cms/apps/worker/src/jobs.ts`.

## 1. What a rule is made of

| Trigger | Happens when | Conditions you can set |
|---|---|---|
| `WEB_LEAD_CREATED` — a new web lead arrives | a website enquiry is saved | New and/or repeat submissions, sources, countries, lowest NEET score |
| `LEAD_UNCONTACTED` — a lead has not been contacted | a lead is still **New** with no call logged after N minutes | minutes (default: the workspace setting “uncontacted minutes”), sources |
| `FOLLOWUP_OVERDUE` — a follow-up call is overdue | an open call is N minutes past its time | minutes overdue (default 24 hours), priority (normal/hot) |
| `STAGE_CHANGED` — a lead’s stage changes | someone (or a rule) moves a lead to a stage | **to** stage (required), **from** stage |

| Action | What it does | Fits |
|---|---|---|
| Assign in turn (`assign_round_robin`) | picks the active counselor or telecaller who was picked longest ago. On a web lead it records who it was **routed to**; on a lead it adds the assignment (skipped if the lead already has one for that role) | web lead (counselor only), uncontacted, stage |
| Send a notification (`notify`) | writes an in-app notification to: the admins, the lead’s counselor, the lead’s telecaller, “whoever this rule just assigned”, or “whoever owns the call”. The title and message can use `{name}`, `{stage}`, `{minutes}`, `{country}` | every trigger (the choice of people depends on the trigger) |
| Escalate (`escalate`) | marks the call escalated and notifies its owner and every admin | overdue call |
| Schedule a follow-up (`schedule_followup`) | creates a call N minutes ahead for the lead’s owner, counselor or telecaller (skipped if the lead already has an open call) | uncontacted, stage |
| Stop reminders (`stop_reminders`) | deletes the lead’s open (not yet made) calls. They are deleted rather than “completed” so reports do not count them as calls | stage |

One rule has up to **5 actions**; a workspace has up to **50 rules**. The same definitions
(`@avn-cms/core/automation`, `definitions.ts`) validate a rule in the rule builder and on the
server, so what the form accepts is what the API accepts.

**Actions never start other rules** (they do not emit events), so rules cannot loop.

### The five starter rules

An admin adds them with **Add starter rules** (safe to repeat: each has a key, so nothing is
duplicated). New workspaces created by the platform start with all five.

| Key | Name | Does |
|---|---|---|
| `route_web_leads` | Route new web leads to a counselor | for **new** submissions: assign a counselor in turn, then tell them |
| `uncontacted_notify` | Tell the admins about leads nobody has contacted | after the workspace’s uncontacted time: notify the admins |
| `escalate_overdue` | Escalate calls that are 24 hours overdue | overdue by 24 h: escalate |
| `interested_schedule` | Schedule a call when a lead becomes Interested | stage → Interested: a call in 1 day for the lead’s owner |
| `enrolled_stop` | Stop reminders once a student is enrolled | stage → Enrolled: remove open calls |

Overdue escalation used to be built into the worker with a fixed 24 hours. It is now the
`escalate_overdue` rule; the migration gives it to every existing workspace so nothing changes
for them, and an admin can now change the delay, switch it off or limit it to hot calls.
`followups.sweepOverdue` only **flags** calls as overdue now.

## 2. How a run happens (and why nothing is lost or repeated)

```
 change committed ──────────────►  PENDING run  ──► job `automation.run` ──► DONE | SKIPPED | FAILED
 (web lead saved, stage changed)   (same transaction)  (after the commit)
 worker sweep (every 2 min) ───►  PENDING run  ──┘
 (uncontacted leads, overdue calls, runs never queued, runs cut off)
```

1. **Recorded with the change.** `emitAutomation` runs inside the transaction of the thing that
   happened. It finds the active rules for the trigger whose conditions fit and inserts one
   `PENDING` run each. A run therefore cannot exist for a change that rolled back, and a change
   cannot lose its runs.
2. **Handed over after the commit.** The runs are given to the `automation.run` job through
   `afterCommit` (an `AsyncLocalStorage` hook in `runInTenant`): hooks run once the transaction has
   committed and never see a rolled-back change. A hook that fails is logged and cannot undo the
   commit.
3. **Carried out all or nothing.** The job claims the run (`PENDING → RUNNING`), reads the rule
   **again**, and runs every action and writes the result in **one** transaction. If an action throws,
   everything it did is rolled back and the run is tried again, up to 3 attempts in all, then it is
   `FAILED` with a plain message. A rule edited so that its actions no longer parse fails
   permanently with “Edit the rule”.
4. **A rule that is off never runs.** A rule that is off is not in the event query, so no run is
   recorded for it; and a run recorded just before it was switched off finds it off when the job reads
   the rule again (`SKIPPED`: “The rule was turned off before it ran.”).
5. **Once per thing.** `(tenant, rule, dedupe key)` is unique. The key is the web lead id, the lead id
   plus the stage-history id (so a lead can enter the same stage twice and be handled twice), or the
   lead id / follow-up id for time-based triggers. A repeated event or a repeated sweep inserts
   nothing.
6. **Time-based rules** have no event, so the worker’s sweep finds them with raw SQL and records the
   runs. The sweep only looks at recent records (**3 days** for uncontacted leads, **7 days** for
   overdue calls), so switching on a rule never floods people about old leads.
7. **Nothing is stranded.** The same sweep queues runs that were recorded but never handed over
   (still `PENDING` after a minute, for example Redis was down), recovers runs a worker left `RUNNING`
   for more than 10 minutes (tried again, or failed once their attempts are used), and deletes runs
   older than **90 days**.

Without Redis (local development, tests) `enqueue` runs the job inside the same process right after
the commit; the worker’s `run-once` entry waits for those jobs to finish before it exits.

### Web leads and counselors

A web lead has no owner until it is converted, so routing records it in `web_leads.routed_to_id`.
A counselor’s **Web leads** inbox shows exactly the submissions routed to them (before Phase 8 it
was empty), they can open and **Convert** those (the new lead is assigned to them), and they cannot
see anyone else’s. Marking spam or rejecting stays admin-only. Converting an enquiry that was routed
to a counselor gives the lead to that counselor (if still active) unless an admin picks someone.

## 3. Screens

- **Automations** (`/app/automations`, admins): the rule list (what it waits for, what it does, how it
  ran this week, turn on/off, edit, runs, delete) and the **Run log** (filter by rule and result; each
  run lists the person, a link to the lead, and what every action did, including “skipped: the lead
  already has a counselor”). A rule that no longer parses is marked **Needs editing**.
- **Rule builder**: a dialog with the trigger, its conditions, up to five actions and an on/off
  switch. Changing the trigger starts with that trigger’s conditions and keeps only the actions that
  still fit. Problems are shown next to the field they belong to.
- **Notifications** (`/app/notifications`, everyone): your own notifications, unread first, **Mark
  read**, **Mark all as read**, a link to the lead. The navigation shows an unread badge that updates
  on every page, every minute, and at once when you mark something read.

## 4. API

All routes are tenant-scoped and need a session; rules and runs need `automation:manage` (admins).

```
GET    /api/automations            rules with their last-7-days stats; meta.missingStarters
POST   /api/automations            create (validated as a whole; field errors by path)
PATCH  /api/automations/:id        edit, or { "isActive": false } to switch off
DELETE /api/automations/:id        delete the rule and its run log
POST   /api/automations/starter    add the starter rules this workspace is missing
GET    /api/automations/runs       run log (?ruleId= &status= &cursor= &limit=)
GET    /api/notifications          my notifications (?unreadOnly=true &cursor= &limit=); meta.unread
GET    /api/notifications/unread   { unread } for the navigation badge
POST   /api/notifications/read     { ids: [...] } or { all: true }
```

Creating, editing, deleting and installing rules are audited (`automation.created|updated|deleted|
starter_installed`).

## 5. Data

`automation_rules` (+ `starter_key`, unique per workspace), `automation_runs` (+ `payload`,
`dedupe_key`, `attempts`, `started_at`, `finished_at`; unique `(tenant, rule, dedupe_key)`),
`notifications` (as before), `web_leads.routed_to_id` / `routed_at`. All carry `tenant_id` and
are under row-level security. See `DATABASE_SCHEMA.md`.

## 6. Verified

- Unit: definitions (every validation and plain-language description), matching, starter rules.
- Integration (`tests/integration/automation.int.test.ts`, `after-commit.int.test.ts`): every starter
  rule fires; a rule that is off never runs; a run is all-or-nothing and retried; nothing crosses
  workspaces; a worker that died loses nothing; duplicates are refused; `afterCommit` never sees a
  rolled-back change.
- Real Redis (`bullmq-jobs.int.test.ts`): a queued run is carried out by the worker; the sweep queues
  a run whose hand-over was lost.
- End-to-end (`tests/e2e/specs/automation.spec.ts`): starter rules installed from the page, a custom
  rule built in the dialog, a web lead routed and the counselor told and able to take it, Interested
  schedules a call and Enrolled stops it, the worker’s sweep finds an uncontacted lead and an overdue
  call, a rule that is off never runs, counselors have no rules page or API, nothing leaks into
  another workspace, and the pages fit a phone.

## 7. Limits and decisions

- **Four triggers.** The documented starter rules need these; others (document verified, payment due)
  belong with their own phases.
- **Notifications are in-app only.** Email and push are not sent; the unread badge is checked every
  minute rather than pushed.
- **The sweep runs every 2 minutes**, so a time-based rule fires up to ~2 minutes after its time.
- **Round-robin ignores workload:** it takes turns (longest ago first) and does not count open leads.
- A rule’s notification text can use four placeholders only; there is no free-form scripting.
- An admin who turns a time-based rule **on** gets runs only for records inside the look-back window.
- Deleting a rule deletes its run log; the audit log keeps a record that it existed.
