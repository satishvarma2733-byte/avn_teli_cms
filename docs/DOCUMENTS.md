# Documents vault (Phase 7)

> Status: built and verified locally against MinIO (an S3-compatible server standing in for R2) and
> ClamAV (2026-10-16). **Not yet run against a real Cloudflare R2 bucket**: that needs your account
> and keys (§9). Code: `avn_cms/packages/core/src/documents/`; screens under
> `apps/web/src/app/(app)/app/documents` and `apps/web/src/components/documents`; API under
> `apps/web/src/app/api/{folders,documents,students/[id]/documents}`.

Two kinds of files, one engine:

- **Student documents**: a checklist per student (passport, marks memo, NEET result, transfer
  certificate, photo, admission letter, visa, payment receipt) plus other files. Shown on a new
  **Documents** tab on the lead.
- **The folder vault** (`/app/documents`): the agency's own files (brochures, fee sheets,
  templates), in folders. Admins only.

Every file is stored privately in Cloudflare R2, uploaded by the browser straight to R2 with a
signed URL, **scanned for viruses before anyone can download it**, and every download is audited.

---

## 1. Who can do what

| | Tenant admin | Counselor | Telecaller |
|---|---|---|---|
| Folder vault (folders, files, versions) | yes | no (403) | no |
| A student's documents: upload, replace, download, remove | any student | students on their own leads (404 for others) | no (403) |
| Verify / reject a checklist item | any student | own leads | no |
| See the Documents tab on a lead | yes | own leads | no |
| See files whose virus scan did not finish, and scan them again | yes | no | no |

The matrix actions are `document:manage` and `studentDoc:verify`; the page and API both enforce
them. Another workspace's documents do not exist as far as you are concerned (404).

---

## 2. How an upload works

1. **Start** (`POST /api/documents`): the server checks the file name and size, decides the type from
   the extension, records the file as pending, and returns a signed URL. The URL is valid 10
   minutes and **signs the exact type and size**: sending different bytes or another type to it is
   refused by storage (403).
2. **Send**: the browser PUTs the file to that URL. It never passes through the web server.
3. **Complete** (`POST /api/documents/:id/complete`): the browser says it is done. The server
   confirms the object exists at the declared size, marks it uploaded, links it to the checklist item
   (status *Uploaded*), writes the audit row and the student's timeline entry, and queues the scan.
4. **Scan** (background): the worker checks the file (§3). Only then is it downloadable.

| Rule | Value |
|---|---|
| Accepted | PDF, JPG/JPEG, PNG, WebP, DOC, DOCX, XLS, XLSX, TXT |
| Size | 20 MB, at least 1 byte |
| Names | path removed, control characters removed, at most 150 characters (extension kept) |
| Not accepted | everything else: executables, scripts, HTML, SVG, archives |

The type comes from the file name. A type the browser reports that contradicts the name is refused.
After the upload the file's first bytes must match its type too (a `.pdf` that is really an
executable is refused).

---

## 3. The scan, and what a file's state means

The worker streams each file from storage to ClamAV (`clamd`, `INSTREAM`). A file is released only
when all three checks pass: the size is the declared size, the first bytes match the type, and
ClamAV finds nothing.

| State shown | Meaning | Downloadable |
|---|---|---|
| Checking | Uploaded, scan not finished (or the scanner is unreachable, see below) | no |
| Ready | Scan clean | yes |
| Blocked | ClamAV found something. The stored file is **deleted at once**; the checklist item becomes *Rejected* | no |
| Refused | Wrong size, or contents do not match the type. The stored file is deleted | no |

**Fail closed.** With no scanner configured (`CLAMAV_HOST` empty) or no answer from it, a file simply stays *Checking*; it is never released unscanned. The worker retries every 2 minutes, up to 5 attempts per file, then gives up. Admins see every such file at the top of the **Documents** page: its name, whose it is (a student, a folder, or the vault), how many tries were made, the last reason, and *Gave up* or *Retrying*. Once the cause is fixed (usually the scanner being down), **Scan again** resets the tries and queues the scan; it is audited as `document.rescan_requested`. The page keeps checking while any are listed, and a file that gets through moves into the file list by itself.

---

## 4. Downloads

`GET /api/documents/:id/url` returns a signed URL valid 5 minutes. The page asks for a fresh one at
the moment of each download. It answers **409** for a file that is still being checked or blocked.

- The audit row `document.downloaded` is written **in the same transaction as the access check**, so
  no link is issued without a record. It records the link being issued; R2 serves the bytes itself,
  so the audit shows who was given a link, not that every byte arrived.
- Files are sent as attachments. A PDF or image can be opened inline when asked for.

---

## 5. Versions

Every upload is a row; versions of one document share a series id. Uploading again for the same
checklist item, or "New version" on a vault file, creates version 2, 3 and so on. The newest
version is current, older ones stay downloadable (listed in `GET /api/documents/:id`). A new version
of a checklist item puts it back to *Uploaded*: a verification applies to the file that was checked.
Deleting a document removes every version from view.

---

## 6. The student checklist

Eight items plus "other documents". Each item is *Missing*, *Uploaded*, *Verified* or *Rejected*.

- *Verify* needs a file that passed the scan. *Reject* needs a reason (shown to the team).
- *Uploaded* can be set again (to undo a verification).
- Removing a file puts the item back to *Missing*.
- Uploads, reviews, blocks and removals appear on the student's timeline (type *Document*).

---

## 7. Folders

Admins only. Nesting up to 8 deep; a name is unique among its siblings (not case-sensitive); a folder
can be renamed; **only an empty folder can be deleted** (nothing vanishes with it). Search looks in
file names across the whole vault.

---

## 8. Retention and housekeeping

The worker's `document-maintenance` job runs every 2 minutes in every workspace:

| What | When | Action |
|---|---|---|
| Scan never ran or failed | uploaded more than 2 minutes ago, fewer than 5 attempts | queue the scan again |
| Blocked or refused file | immediately | remove the stored object |
| Deleted document | 30 days after deletion | remove the stored object |
| Upload that never completed | after 24 hours | remove the object, drop the record |

Until the 30 days pass, a deleted file can still be recovered from storage by someone with access to
the bucket (there is no restore screen).

---

## 9. Setting up Cloudflare R2

You need a Cloudflare account with R2 enabled. Nothing here has been run against your account yet.

1. **Create a bucket** (R2 → Create bucket), e.g. `avn-documents`. Leave public access **off** and do
   not attach a custom domain: the bucket is only reached through signed URLs.
2. **Create an API token** (R2 → Manage API tokens → Create): permission *Object Read & Write*,
   limited to that bucket. Copy the *Access Key ID* and *Secret Access Key* (shown once), and your
   *Account ID* (R2 overview page).
3. **Set the server configuration** (never commit these):

   ```
   R2_ACCOUNT_ID=<your account id>
   R2_BUCKET=avn-documents
   R2_ACCESS_KEY_ID=<access key id>
   R2_SECRET_ACCESS_KEY=<secret access key>
   CLAMAV_HOST=<private address of the clamd server>
   CLAMAV_PORT=3310
   ```

   Leave `R2_ENDPOINT` unset (it is only for local servers). The web app **and the worker** need
   all of these: the web app signs URLs, the worker scans and cleans up.
4. **Set the bucket's CORS rules** so the browser may upload from your site. In the dashboard
   (bucket → Settings → CORS policy) paste, with your own origin:

   ```json
   [
     {
       "AllowedOrigins": ["https://crm.example.com"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["etag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Or run `pnpm storage:setup --origin https://crm.example.com` with an *Admin Read & Write* token
   (an Object Read & Write token cannot set CORS or create buckets).
5. **Check** by uploading a PDF on a lead's Documents tab: it should show *Checking*, then *Ready*,
   and download.

Notes that matter on R2:

- Signed URLs only work on the account's S3 endpoint (`<account>.r2.cloudflarestorage.com`), not on
  a custom domain. The app uses path-style URLs on that one origin, which is also the only extra
  origin the page's Content-Security-Policy allows for `connect-src`.
- The AWS SDK's newer default checksums are turned off for requests (`WHEN_REQUIRED`); R2 rejects
  them on signed uploads.
- R2 does not offer bucket versioning or object ACLs; neither is used (versions are rows).
- Objects are encrypted at rest by R2. The app adds no extra per-file encryption.

---

## 10. ClamAV

`clamd` must be reachable from both the web process and the worker at `CLAMAV_HOST:CLAMAV_PORT`.

- Run the official `clamav/clamav` image (about 1.5–2 GB of memory; it updates its own signatures).
- **Keep it on a private network.** `clamd` has no authentication; never expose port 3310.
- Its `StreamMaxLength` (default 25 MB) must stay at or above the 20 MB upload limit.
- Signature updates protect new uploads only; files already marked *Ready* are not rescanned.

---

## 10a. Health and monitoring

`GET /api/health` reports `storage` (R2) and `scanner` (ClamAV) as `up`, `down` or `not_configured`.
They never change `status` or the HTTP code: the rest of the CRM works without documents, and a load
balancer must not pull every instance because R2 or ClamAV is down. Alert on either being `down` as a
separate check. Each probe gives up after 1.5 seconds and the answer is kept 15 seconds per instance, so
frequent probing does not hammer R2 or clamd. Storage is checked with `HeadBucket`; the scanner with clamd's `PING`.
Cloudflare lists `HeadBucket` as supported, but it has not been tried with a bucket-scoped Object Read & Write
token: if `storage` shows `down` while uploads work, check that first.

---

## 11. Local development

`pnpm stack:up` starts MinIO (S3 API on `127.0.0.1:19000`, console on `19001`) and ClamAV (host port
`33100`) with the other services. `.env.example` has the matching values (`R2_ENDPOINT`, `R2_BUCKET`,
`CLAMAV_HOST`…). `pnpm storage:setup` creates the bucket. Tests use a separate bucket
(`TEST_R2_BUCKET`) so they never touch development files. The first ClamAV start downloads its
signatures.

Docker Hub no longer lets new machines pull `minio/minio`. If the image is missing for you, point
`R2_ENDPOINT` at any S3-compatible server (or a development R2 bucket) instead.

---

## 12. API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/folders?parentId=` | Sub-folders of a folder or the root, with the path (admins) |
| POST | `/api/folders` | `{ name, parentId? }` |
| PATCH / DELETE | `/api/folders/:id` | Rename; delete when empty |
| GET | `/api/documents?folderId=&q=` | Newest version of each file in a folder, or a search (admins) |
| POST | `/api/documents` | Start an upload → `{ document, upload: { url, method, headers } }` (201) |
| POST | `/api/documents/:id/complete` | Confirm the upload and queue the scan |
| GET | `/api/documents/:id` | The document and all its versions |
| GET | `/api/documents/:id/url?disposition=` | Signed download URL (409 until clean) |
| DELETE | `/api/documents/:id` | Remove every version |
| GET | `/api/documents/stuck` | Files whose scan did not finish, with the reason and tries (admins) |
| POST | `/api/documents/:id/rescan` | Reset the tries and queue the scan again (admins; 409 if already checked) |
| GET | `/api/students/:id/documents` | The checklist and other documents |
| PATCH | `/api/students/:id/documents/:docType` | `{ status: UPLOADED \| VERIFIED \| REJECTED, note? }` |

Storage not set up answers **503** with a plain message. Audit actions: `folder.created`,
`folder.renamed`, `folder.deleted`, `document.upload_started`, `document.uploaded`,
`document.scanned`, `document.rejected`, `document.downloaded`, `document.deleted`,
`document.reviewed`, `document.rescan_requested`.

---

## 13. Tests, and what is not covered

| Suite | Covers |
|---|---|
| Unit `documents.test.ts` (18) | accepted types, signatures, file names, download header, storage settings, the clamd protocol and its health probe against a fake server |
| Integration `documents.int.test.ts` (14) | the whole flow on real MinIO and ClamAV: upload → scan → download; infected (EICAR) never downloadable and removed; wrong contents refused; storage refuses another size or type; scanner down → stays pending, released on retry; counselor scope and 404s; other workspace; versions and re-review; review rules; folders; purge after retention; abandoned uploads |
| Integration `documents-ops.int.test.ts` (7) | a file the scanner could not check is listed, retried to the limit, and released by "scan again" (audited); vault files show their folder; admin-only and own-workspace rules; storage and scanner health up, down (and quickly), not configured, and `/api/health` still 200 when they are down |
| Integration `bullmq-jobs.int.test.ts` | the scan runs on the worker through real Redis, clean and infected |
| End-to-end `documents.spec.ts` (6) | a real browser uploads to MinIO, the file is scanned, downloaded and verified; new version; infected blocked; counselor/telecaller access; the vault; the page fits a phone; a file whose scan gave up is listed with its reason and "Scan again" releases it |

Not covered or not built:

- **Real R2** (see the note at the top). MinIO speaks the same S3 API, but R2 differences (CORS
  behaviour, checksum handling) are only checked against R2's documentation.
- Downloads are audited when the link is issued, not when the bytes are fetched.
- No restore screen for deleted documents; no previews or thumbnails; no per-student file cap.
- Antivirus is signature-based (ClamAV): it does not sanitise PDFs or Office files.
