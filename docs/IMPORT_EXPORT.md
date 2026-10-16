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
`RUNNING` → `DONE`. `FAILED` can happen during a check or a run; **Change columns** can run the
check again. `CANCELED` is possible only before the run starts.

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
- Progress is saved after every batch. A run that is cut off (for example, the worker stops) is not
  recovered automatically: its job stays RUNNING and needs attention. To finish that file, upload it
  again; students already created are handled by the chosen duplicate behaviour. This is a known gap
  (see §12).

- **Problem report** (`<file>-problems.csv`): one line per problem, with the line number,
  severity (skipped or warning), field, the problem in plain words, and the original cells of
  that row. Spreadsheet formulas in those cells are neutralised. Kept 30 days.
- Each download link is signed for you and lasts 15 minutes. The page asks for a fresh link
  when you click, so an open page keeps working.

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
- **Background jobs** use the `avn-jobs` BullMQ queue (two at a time, lock 5 minutes). Without
  Redis (`REDIS_URL` empty) jobs run in the web process, which is only suitable for local
  development.

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
| Migration guards | `packages/db/src/migrations.test.ts` (3) | Generated migrations never drop the protected indexes; row-level security on every tenant table |
| End-to-end | `tests/e2e/specs/import-export.spec.ts` (4) | Admin wizard from upload to students in the workspace, with accessibility checks; the import list; export download and exports list; telecaller export without contact columns and with no import access |

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
- A run cut off by a crash is not recovered automatically (see §7).
- Storage is the database until the Phase 7 object-storage decision.
