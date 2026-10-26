# Reporting — aVn CMS

> The dashboard and the Reports centre: what each number means, how it is computed, who sees what, and how fresh it
> is. Code: `packages/core/src/reports/report.service.ts`, answer cache `packages/core/src/shared/cache.ts`,
> pages `/app/dashboard` and `/app/reports`, API `GET /api/reports/{dashboard|funnel|sources|team|status|followups}`.

## 1. Principles

- **Real rows, no estimates.** Every number is a query over the agency's own data, inside a tenant transaction
  (row-level security applies). A test reconciles the funnel, sources and stage report against raw counts
  (`tests/integration/reports.int.test.ts`, `reports-scale.int.test.ts`).
- **Scope follows the role.** Admins see the agency (and can look at one person); counselors and telecallers only
  ever get their own numbers — passing someone else's id is ignored, not honoured.
- **Deleted records do not count.** Students and leads that were deleted drop out of every figure.
- **Dates are the agency's.** Day boundaries ("today", date ranges) use the agency's time zone setting
  (default Asia/Kolkata), so a lead created at 23:30 counts on the day the team saw it.

## 2. Filters (Reports centre)

`dateFrom`, `dateTo` (inclusive days), `sourceId`, `state` (case-insensitive), `assigneeId` (admins only). The page
opens on the last 30 days. The date filter applies to when a lead was **created** (funnel, sources, stage, team) and
to when a call was **made** (call figures).

## 3. The reports

| Report | Answers | How it is computed |
|---|---|---|
| **Funnel** | Of the leads in scope, how many reached at least each stage? | For every lead, the furthest progress stage it ever held (stage history plus its current stage); a lead counts for that stage and every earlier one, so a lead that skipped "Contacted" still counts there. Shown as counts and as % of all leads in scope. Only the 11 progress stages; closed and parked leads count up to the furthest progress stage they reached. |
| **Sources** | Which sources bring volume and results? | Per lead source: leads, contacted (a call was made or the stage moved on), enrolled, lost (the six closed stages), and conversion % = enrolled ÷ leads. This is conversion, not cost: ad spend is not recorded, so there is no cost-per-enrolment. |
| **Stage distribution** | Where do the leads stand now? | Count of leads currently in each stage. |
| **Team** | How is each person doing? | Per counselor and telecaller: leads (active assignments), active, potential, enrolled, conversion %; calls made, connected % and no-answer %; overdue calls. Sorted by enrolled, then conversion, then calls. A counselor or telecaller sees a single row: their own. |
| **Follow-ups** | How are calls going? | Calls logged by outcome in the period, plus the open, overdue and escalated calls right now. |

Definitions used above: **active** = not enrolled and not in a closed stage; **connected** = a disposition where
someone was reached (completed, interested, not interested, call back later, awaiting feedback); **no answer** = no
answer, busy, switched off. The same definitions are used on the dashboard (`FOLLOWUP_ENGINE.md` §4).

## 4. The dashboard

Role-aware (`PAGES_AND_ROUTES.md` "Dashboard composition"):

| Card | Meaning |
|---|---|
| Total / My active leads | Leads that are not enrolled and not closed |
| Calls scheduled today / My calls today | Open calls scheduled within today |
| Potential leads | Active leads marked potential |
| Enrolled | Leads in the Enrolled stage |
| Overdue follow-ups | Open calls scheduled before today |
| Completed today | Calls logged today |
| Callbacks due | Open calls due by the end of today on leads that once asked to be called back |
| No-answer rate | Of the calls logged in the last 7 days, the share with no answer, busy or switched off |
| New, not contacted | New leads with no contact yet (and the number of web leads waiting, for admins) |

Below the cards: the call queue (next 8 open calls up to the end of today, oldest first), recent activity (10 newest),
the all-time conversion funnel and new leads per day for the last 30 days (not shown to telecallers).

## 5. How fresh it is

Reading these figures means scanning a large share of an agency's leads and calls, so they are not recomputed for every
page view:

- The agency-wide dashboard cards, the 30-day trend and the funnel on the dashboard, and every report are kept for
  `REPORT_CACHE_SECONDS` (default **60**). After that, for ten times as long, the previous answer is returned at once
  while a new one is computed in the background (stale-while-revalidate), so nobody waits for a recompute except the
  first person after a quiet spell. One computation runs at a time per key, however many people ask.
- **A person's own cards, call queue and activity are never cached**, so the call a telecaller just logged shows
  on their next page view.
- Keys include the agency, the report, the person's scope and the filters, so an answer can only be served to someone
  entitled to it. With Redis the cache is shared by all web instances; without it each instance keeps its own.
- `REPORT_CACHE_SECONDS=0` turns caching off (the test suites do). Staleness is therefore at most about a minute for
  agency-wide figures; figures that must be exact to the second should come from the lists, not the dashboard.

## 6. At scale

The queries were rewritten for large agencies: the dashboard cards are two passes (one over leads, one over
follow-ups) instead of a dozen counts; the funnel summarises stage history first when it covers the whole agency; the
team report no longer sorts a million assignments. Timings at 1,000,000 leads, before and after: `SCALABILITY.md` §5.

## 7. Not in reports yet

Cost per lead / return on ad spend (needs spend data), scheduled email reports, cohort and time-to-enrol analysis,
saved report views and exports of report tables (`IMPROVEMENT_ROADMAP.md`).
