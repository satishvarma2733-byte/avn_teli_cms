# Import and export (Phase 6)

> Status: built and verified locally (2026-10-16). Code: `avn_cms/packages/core/src/imports/`,
> `exports/`, `storage/`, `jobs/`; screens under `apps/web/src/app/(app)/app/imports`,
> `exports`; API under `apps/web/src/app/api/imports`, `exports`, `files`.

Bulk data in and out, safely. Nothing is written to the database until an admin confirms the
check. Exports never run inside a web request: the request records a job and a background
worker writes the file.

---

## 1. Who can do what

| Action | Super admin (no workspace) | Tenant admin | Counselor | Telecaller |
|---|---|---|---|---|
| Import students (wizard, template) | — | yes | — | — |
| Export leads | — | all leads | own leads | own leads, fewer columns |
| Export web leads | — | yes | — | — |
| See an export or import | — | own exports; all imports in the workspace | own exports | own exports |
| Download an import report | — | own, and other users' import files | — | — |

Roles come from the same policy matrix as the API (`import:run`, `export:run`). Visibility is
checked again when the background job runs, so a user disabled after asking gets no file.

---

## 2. Import wizard

Four steps, each its own screen (`/app/imports/new` → `/app/imports/:id`). The page resumes if
you reload or come back later.

1. **Upload.** Choose a `.csv` or `.xlsx` file. Nothing is saved to students yet; the file is
   kept (30 days) so the check can run.
2. **Map columns.** Each import field is matched to a column of your file. Columns are matched
   automatically by header (see §3). You see the first rows of the file, and an example value
   under each choice. Choose a default source (used for rows that don't name one) and,
   optionally, share unassigned students between counselors in turn. **Check file** runs a
   dry run in the background.
3. **Check results.** Nothing is saved yet. The screen shows: rows in the file, rows ready to
   import, new students, students already in aVn CMS, rows that need fixing, and repeated mobile
   numbers. Problems are listed (first 15), and the full problem report is a CSV download. You
   choose what happens to students already in the workspace (§5), then **Start import**.
   **Change columns** goes back to step 2. **Cancel import** stops here; nothing was saved.
4. **Import.** The job runs in the background; the page shows progress and you can leave it.
   The finished screen shows created, updated, merged, skipped and failed counts, a link to the
   problem report, and a link to the leads list.

The import list (`/app/imports`) shows every import with its status and result.

### Job states

`DRAFT` (needs columns) → `VALIDATING` (check) → `VALIDATED` (ready to review) → `QUEUED` →
`RUNNING` → `DONE`. `FAILED` can happen during a check or a run, including a run cut off by a
crash (§7); **Check the file again** and **Change columns** run the check again. `CANCELED` is
possible only before the run starts, or after a failure. If the queue refuses the job when the
import is started, it goes back from `QUEUED` to `VALIDATED` (§7).

---

## 3. File rules and column matching

| Rule | Limit |
|---|---|
| Formats | `.csv` (UTF-8, or Windows "CSV (MS-DOS)" as a fallback) and `.xlsx` (first sheet) |
| Size | 20 MB |
| Rows | 100,000 per file (split larger files) |
| Columns | 80 |
| Cell length | 5,000 characters (longer text is cut) |

- CSV delimiter is detected (`,` or `;`). A leading byte-order mark is ignored.
- Spreadsheet formulas are read as their stored values; they are not recalculated.
- The first non-empty row is the header. Blank header cells become `Column N`.
- A downloadable template (`/api/students/template`) lists the main columns with one example row.


**Automatic matching.** Headers are compared with each field's name and common alternatives
(for example "Mobile", "Phone number" and "WhatsApp" match *Mobile number*). An exact match is
preferred; then a header that contains a known name. A column is used for one field only. The
column names of LeadXP's own exports ("Followup Status", "Lead Source", "Counsellor", "Next
Followup") are recognised, so a LeadXP export maps without edits.

### Fields

| Field | Required | Notes |
|---|---|---|
| Student name | yes | Empty → row skipped |
| Mobile number | yes | Indian mobile; unusable → row skipped. Stored as E.164 (+91…) |
| Alternate number | no | Invalid → warning, kept in the note |
| Parent name | no | |
| Email | no | Invalid → warning, kept in the note |
| Town / city, District, State, Address | no | |
| Lead source | no | Matched by code or label; unknown → default source, with a warning |
| Stage / status | no | See §4; unknown → New, with the original text kept in the note |
| Last call outcome | no | See §4; unknown → warning, kept in the note |
| Country of interest, Course, NEET score | no | |
| Counselor, Telecaller | no | Active users only, matched by email or name (case-insensitive); no match → left unassigned, with a warning |
| Potential (yes/no) | no | Other values → ignored, with a warning |
| Priority (HOT) | no | `HOT` marks the lead HOT; `normal` or blank is normal |
| Next call (date/time) | no | Creates a follow-up for the assignee (or the default owner) |
| Enquiry date | no | Day-first (`20-10-2026`, `20/10/26`), ISO, or an Excel date; read in the workspace time zone. Bad or future date → today, with a warning |
| Notes / remarks | no | Saved as a note on the lead |

---

## 4. Stage and outcome mapping

Common LeadXP and spreadsheet wordings are mapped to aVn CMS stages (case and spacing are
ignored): for example *Fresh* → New, *Followup* or *Followup required* → Follow-up required,
*Call back later* → Follow-up required with the outcome Call back later, *Potential lead* →
Potential, *Not enrolled* → Not interested, *Admitted* or *Joined* → Enrolled, *Wrong number* →
Invalid, *Unreachable* → Unreachable. The stage names themselves are accepted too.

Call outcomes accept the aVn CMS labels and common wordings (*RNR*, *Ringing* → no answer;
*Busy*; *Switched off* / *Not reachable*; *Callback* / *Call again* → call back later;
*Spoke* / *Connected* / *Contacted* → completed).

Imported history: the lead starts at New, then moves to the imported stage, with the status
history showing "Imported from <file>". The call outcome is recorded as an activity marked
imported.

---

## 5. Students already in aVn CMS

A student is matched by mobile number across the workspace (deleted students are ignored).
Choose one behaviour for the whole file:

| Choice | What happens to an existing student |
|---|---|
| **Skip them** (default) | Nothing changes. Counted as skipped. Safe for a first import. |
| **Update them** | Their details are replaced with the non-empty values in the file. A stage in the file moves the lead to that stage, and a counselor or telecaller in the file replaces the current one. |
| **Fill in the gaps** | Only empty details are filled in, and a counselor or telecaller is added where the lead has none. Stages stay as they are. |

If the existing student has no lead, one is created with the file's source and stage.

**Repeated numbers inside one file:** the first row wins; later rows with the same mobile are
skipped and reported as warnings.

---

## 6. Assigning owners (round robin)

When *Share students without a counselor* is on, rows with no counselor are given to active
counselors in turn, starting with the counselor who was picked least recently. Rows that name a
counselor keep that counselor. Telecallers are only assigned by name or email in the file.

---

## 7. Running the import and the problem report

- The run writes in batches of 500 rows; each batch is one transaction. A row that fails inside
  a batch is retried on its own, so one bad row does not block the others. Failed rows are
  counted and listed in the report.
- Progress is saved after every batch, together with a **heartbeat**: the job's last sign of life.

### A run that is cut off

If the worker stops mid-run (a crash, a deploy, out of memory) nobody is left to finish the
job, and BullMQ handing it to another worker changes nothing: the job has already been claimed
(QUEUED → RUNNING), and a claimed job is never taken over.

- **Detection.** The worker's `stuck-jobs` job (queue `avn-system`, every 2 minutes) marks every
  import that is VALIDATING or RUNNING, and every export that is RUNNING, as **FAILED** when its
  heartbeat is more than 10 minutes old. Imports record it as `failedIn: check` or `run`, keep the
  progress they had saved, and say what happened: "The import stopped before it finished (the server
  was probably restarted). At least 1,500 of 5,000 rows had been processed." A job still waiting in
  the queue (QUEUED) is not touched: it runs when a worker is back. Without Redis,
  `pnpm --filter @avn-cms/worker sweep:once` does the same once (for cron).
- **Starting over.** The import screen shows **The import didn’t finish**, with what was saved
  before it stopped, and three actions: **Check the file again** (the same columns, checked again;
  students the stopped run already added now show as *Already in aVn CMS*), **Change columns**, and
  **Cancel import** (the students already added stay). Then choose what to do with students already
  in the workspace and start the import again. The import list shows the stopped import as Failed,
  with how far it got. A stopped export says so in the exports list; request it again.
- **No duplicates.** Students are matched by mobile number, so a second run never adds a student
  twice, in any mode. With **Skip them** (the default) the students the stopped run added are left
  alone. With **Update them** or **Fill in the gaps** they are processed again, which repeats the
  file's notes and next-call follow-ups on those students: choose **Skip them** unless the rest of
  the file still needs those changes.
- **A slow job is not a dead one.** If recovery fails a job that was only slow, its runner notices
  at its next batch (it saves progress only while the job is still RUNNING), stops, and leaves the
  job as recovery left it. It never turns FAILED back into DONE. Batches it had saved stay.

- **Problem report** (`<file>-problems.csv`): one line per problem, with the line number,
  severity (skipped or warning), field, the problem in plain words, and the original cells of
  that row. Spreadsheet formulas in those cells are neutralised. Kept 30 days.
- Each download link is signed for you and lasts 15 minutes. The page asks for a fresh link
  when you click, so an open page keeps working.

### A job the queue refused

Starting an import or asking for an export first records the job as QUEUED, then hands it to the
queue. If the queue does not take it, no worker ever hears of the job, and the stuck-jobs sweep
leaves QUEUED alone (a job may wait for a worker). So the request undoes its own recording before
it reports the error:

- **Not answering counts as refusing.** With Redis unreachable BullMQ never gives up by itself
  (it keeps waiting for the connection), so the request would hang. `enqueue` waits at most 10
  seconds (`ENQUEUE_TIMEOUT_MS`) and then throws; an error from Redis throws as soon as it arrives.
- **Import.** QUEUED → VALIDATED, with the check results kept: the screen is back at **Start
  import**, and the person can start again, change columns or cancel.
- **Export.** QUEUED → FAILED, with "The export could not be started. Try again." in the exports
  list; the person requests it again.
- **Only while QUEUED.** If a worker did take the job (the queue accepted it but the answer was
  lost), the job is left alone and runs; the person still sees the error.
- The request still fails, with the usual "Something went wrong on our side" message and a
  reference for the log. The check step is not covered here: a check that could not be queued stays
  VALIDATING with its heartbeat, and the sweep fails it after 10 minutes like a cut-off one.
- If the queue answers after the request gave up, the stray BullMQ job finds the row no longer
  QUEUED and does nothing.

---

## 8. Exports

Export from **Leads** or **Web leads** with the **Export** button, or list all your exports under
**Exports**. The dialog offers CSV, Excel (.xlsx) or PDF.

- **Filters are the screen's filters.** The leads export takes the view, search, stage, source,
  counselor, telecaller and state filters from the URL; the web-leads export takes the status
  tab (New when no tab is chosen) and the search. Sorting does not change which rows are
  included.
- **Columns by role.** Telecallers do not get Email or Address; every other role gets the full set.
  Leads columns: student name, mobile number, alternate number, parent name, email, town, district,
  state, address, status, potential, priority, country, course, source, counselor, telecaller, next
  call, last contacted, enquiry date. Web leads columns: name, mobile number, email, status, source as
  sent, city, NEET score, country, message, UTM source, UTM medium, UTM campaign, Google click id,
  page URL, blog post, submitted.

- **Limits.** 200,000 rows per export (narrow the filters beyond that); PDF up to 5,000 rows
  (PDF uses fewer columns).
- **Dates** are day-first, like the import, so an export can be imported again.
- **Safety.** Spreadsheet formulas (cells starting with `=`, `+`, `-`, `@`) are neutralised in
  CSV and Excel output.
- **Lifetime.** Files are kept 7 days, then removed by the worker. Download links last 15
  minutes; the exports list asks for a fresh link when you download. Every download is audited.

---

## 9. Storage, security and audit

- **Storage.** Import uploads, problem reports and export files are kept in the `stored_files`
  table (tenant-scoped, with row-level security like every other tenant table). Object storage
  comes with Phase 7; the file API is shaped so an S3 driver can replace the table without
  changing the callers.
- **Retention.** Import uploads 30 days; problem reports 30 days; export files 7 days. An hourly
  worker job removes expired files across all workspaces.
- **Links.** `/api/files/:id?exp=…&sig=…` is an HMAC of the file, the user and the expiry
  (keyed with `SESSION_SECRET`). It also needs the signed-in user to be the one the link was
  made for; anyone else gets 404. An expired but genuine link returns 410 with a message.
- **Who can read what.** An export belongs to the person who asked for it. Import files
  (uploads and problem reports) can be read by the person who uploaded them and by tenant
  admins.
- **Rate limits.** Uploads and export requests: 20 per minute per user. Validate and run: 30 per
  minute. Downloads: 120 per minute.
- **Audit log.** `import.upload`, `import.start`, `import.run`, `import.cancel`,
  `export.requested`, `export.run`, `export.downloaded`, `file.downloaded`.
- **Background jobs** use the `avn-jobs` BullMQ queue (two at a time, lock 5 minutes). Every
  request gets its own BullMQ job id (BullMQ refuses ids containing `:`, and ignores an id it has
  seen before, which would silently drop an import that is checked or run a second time). A request
  waits at most 10 seconds for the queue (§7, "A job the queue refused"). Without
  Redis (`REDIS_URL` empty) jobs run in the web process, which is only suitable for local
  development: a restart of that process cuts a job off, and only `sweep:once` recovers it.

---

## 10. API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/imports` | List your workspace's imports (newest first) |
| POST | `/api/imports` | Upload a file (multipart, field `file`); returns the draft (201) |
| GET | `/api/imports/:id` | Status, mapping options, check results, error-report link |
| POST | `/api/imports/:id/validate` | Confirm the mapping and start the check (202) |
| POST | `/api/imports/:id/run` | Start the import with `{ duplicateMode }` (202) |
| DELETE | `/api/imports/:id` | Cancel before the run starts |
| GET | `/api/students/template` | Downloadable CSV template |
| GET | `/api/exports` | Your exports (newest 20) |
| POST | `/api/exports` | `{ entity: leads \| web_leads, format: csv \| xlsx \| pdf, filters }` (202) |
| GET | `/api/exports/:id` | Status and a fresh download link when ready |
| GET | `/api/files/:id` | Signed download (`exp`, `sig`) |

Responses use the usual envelope (`{ data, meta }` or `{ error }`). Invalid filters are refused
when the export is requested, with field messages.

---

## 11. Tests

| Suite | File | Covers |
|---|---|---|
| Unit | `packages/core/src/imports/imports.test.ts` (10) | Header matching, LeadXP headers, stage and outcome mapping, dates, phone and yes/no parsing, CSV delimiter and encoding |
| Integration | `tests/integration/imports.int.test.ts` (7) | Wizard rules: mapping checks, check results, duplicate modes, round robin, cancel, template |
| Integration | `tests/integration/imports-50k.int.test.ts` (1) | **Phase 6 exit:** 50,000 good rows and 100 bad ones; exactly the good rows created; report lists exactly the bad ones |
| Integration | `tests/integration/exports.int.test.ts` (7) | Same rows as the screen, formula neutralising, role columns, XLSX and PDF output, personal and expiring links, web-leads admin only, re-check when the job runs, bad filters refused |
| Integration | `tests/integration/job-recovery.int.test.ts` (6) | Only claimed jobs silent for 10 minutes are failed (queued, busy and finished ones are not); a re-delivered job does not run again; the worker sweep covers every workspace; **a run failed under the real runner stops without overwriting that, and starting over finishes the file with every student exactly once** (skip mode, and update mode after a run cut off at the end) |
| Integration (real Redis) | `tests/integration/bullmq-jobs.int.test.ts` (2) | The web side enqueues on `avn-jobs`, the worker's own consumer (`apps/worker/src/workers.ts`) runs the check and the import and an export through `processJob`, and BullMQ records the three jobs as completed; an import checked a second time is processed again. Needs the docker Redis (`pnpm stack:up`); uses Redis database 15 (`TEST_REDIS_URL`) |
| Integration | `tests/integration/enqueue-failure.int.test.ts` (6) | A job the queue refused (§7): an import goes back to VALIDATED and can be started again or canceled; an export fails with the plain message and can be requested again; a job a worker already claimed is left alone; with Redis unreachable (a closed port, no docker needed) the request gives up instead of hanging and does the same |
| Migration guards | `packages/db/src/migrations.test.ts` (3) | Generated migrations never drop the protected indexes; row-level security on every tenant table |
| End-to-end | `tests/e2e/specs/import-export.spec.ts` (5) | Admin wizard from upload to students in the workspace, with accessibility checks; the import list; **an import cut off mid-run, failed by the worker's `sweep:once`, shown as stopped, started over, and finished without a duplicate**; export download and exports list; telecaller export without contact columns and with no import access |

Timing on the development machine (Windows 11, local Postgres 17): the 50,000-row import
checked in 3.3 s and imported in about 93 s in total (about 540 rows a second, including the
checks and the problem report).

---

## 12. Not yet

- No import of documents or attachments (Phase 7).
- No scheduled or emailed exports; exports are on demand only.
- No `.xls` (older Excel) files; save as `.xlsx` or CSV.
- Files over 100,000 rows must be split.
- Telecallers are not assigned by round robin.
- A stopped import is not resumed from where it stopped: the person starts over (§7). Resuming
  would need the progress saved in the same transaction as each batch (today it is saved just
  after), so that no batch could be repeated.
- Storage is the database until the Phase 7 object-storage decision.
