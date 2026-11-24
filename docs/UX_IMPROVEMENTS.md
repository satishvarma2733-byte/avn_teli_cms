# UX improvements — aVn CMS

> A running list of what was improved over the original LeadXP tool, what the browser tests protect, and what is
> still rough. Status: **Done** (built and tested), **Open** (known gap, scheduled in `IMPROVEMENT_ROADMAP.md`),
> **Idea** (worth trying, needs a decision or user research). Updated at the end of each phase; last update 2026-11-24 (a screen-by-screen walkthrough as every role, §5).

## 1. Improvements over the original, now in the product

| Area | Was | Now | Status |
|---|---|---|---|
| Lead history | One comment field | Append-only timeline per lead (calls, notes, stage moves, assignments, documents, system events) | Done |
| Status model | `Status` and `Followup Status` overlapped | One pipeline stage, one call outcome, and a call outcome only *suggests* a stage | Done |
| Call outcomes | Free-form | Ten dispositions; logging a call can book the next one in the same step | Done |
| Overdue work | Not visible | Overdue bucket, dashboard card, escalation rule, notification | Done |
| Bulk work | Per-row dropdowns only | Select rows → reassign, set stage, block | Done |
| Adding a student | Duplicates slipped in | The phone is checked on submit; a duplicate is refused with the existing student's id so the form can point to them | Done |
| Imports | One-shot | Wizard: upload → map columns → dry run with a problem report → import; a cut-off import can be restarted | Done |
| Reports | A record list | Funnel, sources, team (with conversion), stage, call outcomes; date, source, state and person filters | Done |
| Big lists | Slow with many rows | 50 rows per page, virtualised rows, keyset paging; a total that says "1,000+" instead of making the page wait | Done |
| Roles | Hidden buttons | Telecallers see a reduced student view; the server enforces it everywhere | Done |
| Documents | None in the app | Per-student checklist and folder vault, scan status shown on every file | Done |
| Timeline and dashboard text | Machine values: `2026-10-19T15:25:00.000Z`, `FOLLOW_UP_REQUIRED`, `phoneE164` | The agency's own clock ("17 Jan 2030, 9:00 am"), stage and outcome names, plain field names; lines written before this are cleaned up when shown | Done |
| Audit log | Action codes and raw JSON | The action in words with its code beneath, the record with "Open student" and "Only this record", one line per changed field, the raw values one click away; a filter for every area | Done |
| An empty call queue | "No calls here" while 29 calls were overdue | "Today is clear, but some calls from earlier days are still waiting" and a "See 29 overdue calls" button | Done |
| Assignment pickers | Showed "Unassigned" until the names loaded, and for someone since deactivated; "Unassigned", "None" and "Auto / none" for the same thing | The assigned person shows at once (a former member too); one word, "Unassigned" | Done |
| Labels | Lowercase codes ("tenant admin", "converted"), "This month is 2026-11", "15 Oct, 8:18 pm · 15 Oct 2026" | One role name everywhere, capitalised statuses, "November 2026", "40 days ago" | Done |

## 2. Design rules the interface follows (and tests check)

- **Accessible by default.** WCAG A/AA checks (axe, serious and critical) run in the browser tests on the main pages;
  form errors name the field; focus is visible; charts have a table view and labels, never colour alone.
- **Works at phone width.** The browser tests open **every screen** (17 admin pages, a lead's page, the platform
  console, and the signed-out pages) at 390 px and at 768 px (`responsive.spec.ts`) and fail on sideways scrolling,
  on a failed accessibility check, or when the menu button does not reach the navigation. A wide table scrolls inside
  its card, and that card can be focused and scrolled with the keyboard (`scrollRegionProps` in
  `components/ui/primitives.tsx`; the sweep found three tables without it, and all ten now have it).
- **Plain words, never machine values.** Text stored for people (timeline lines) is written in the agency's time zone
  with the product's names; codes, timestamps and ids stay in the data and the raw view of the audit log
  (`readableSummary`, `formatInTz`, `ROLE_LABEL` and the audit `describe` module, each with unit tests).
- **Plain words for missing fields.** A required box left empty says what to enter ("Enter the student’s name."), never a
  validation library's own wording. The schemas carry the message for a missing field as well as an empty one.
- **Honest empty, loading and error states.** "Storage is not set up" says so rather than failing silently; errors
  carry a short reference that matches the log; nothing says an email was sent when SMTP is off (the admin is shown
  the link instead).
- **Indian conventions.** Numbers use the lakh/crore grouping (`10,00,000`), phone numbers default to India, times
  use the agency's time zone (default Asia/Kolkata).
- **One hue for data.** Charts use a single validated hue so a screenshot in greyscale or for a colour-blind reader
  still reads.
- **Light and dark** themes from design tokens.

## 3. Open

| Item | Why it matters | Where it goes |
|---|---|---|
| Notifications are checked once a minute, not pushed | A manager learns of an escalation up to a minute late | Server-sent events or web push — P1 |
| No keyboard shortcuts in the call queue | Telecallers make hundreds of calls a day; "log outcome" should be one key | P1 |
| Saved views are fixed (All, Mine, Today, …) | Teams want their own, shared filters | P1 |
| Bulk select covers the loaded rows only | "Select all 4,200 matching" is the natural next step | P1 |
| No merge screen for duplicate students | Two records for one person need a manual fix today | P1 |
| Reports cannot be exported or scheduled | Owners paste into spreadsheets and email | P1 |
| Dashboard figures can be a minute old | Correct for a dashboard, but a "refreshed 40 s ago" note and a refresh button would say so | P2 |
| Search is a single box over name, parent and phone | Fine for finding a person; no "phone starts with", no saved searches | P2 |
| First-run experience | A new agency lands on an empty dashboard; a checklist (add people, add a source, connect a website, import) would help | P1 |
| No in-app help or changelog | | P3 |
| The usage month on Settings is counted in UTC | In India the first 5½ hours of a month count towards the month before | P3 |

## 4. Ideas to test with real users

- A **call-mode** page: one lead at a time, big phone number, script and history alongside, outcome buttons, auto-advance.
- **Next best action** per lead (who to call now and why), once there is enough history (`AI_ROADMAP.md`).
- Counselor home with **"leads going cold"** (no contact in N days for a stage that should move).
- **Documents chase**: one click sends the family a list of what is still missing (needs WhatsApp or email).
- Hindi and regional-language UI strings; agencies' staff are comfortable in English, families are not.
- Mobile-first telecaller screen as an installable web app.

## 5. Walkthrough of 2026-11-24

Every screen was opened on a production build as an admin, a counselor, a telecaller and the platform admin, and the
call queue and a student page at phone width. Fixed: the rows added to §1 above, a report card that said "leads
currently assigned" while counting only leads created in the chosen range (now says so), and wording on the platform
console ("Open as admin" instead of "audited impersonation"). Checked and found correct: field labels on sign-in, the
"Mark all as read" button (disabled when nothing is unread), the menu per role, tap-to-call on the queue and the
student page, the overdue colour on next calls in the list. One gap went to §3: the usage month on Settings is counted in UTC.

## 6. How this list is kept

Each phase adds the improvements it ships to §1 and the gaps it finds to §3, with the browser test that protects the
behaviour. User research (shadowing a telecaller for a day, a counselor review of the timeline) is the main thing
this list is waiting for; none has been done yet.
