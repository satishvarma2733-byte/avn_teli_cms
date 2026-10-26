# User roles — aVn CMS

> Who the four kinds of user are, what each can do day to day, and how people are added, changed and removed.
> The exact permission cells are in `RBAC_MATRIX.md`; this page is the plain-language version.
> Code: `packages/core/src/policy/` (the rules), `packages/core/src/users/` (people), `packages/auth/` (sign-in).

## 1. The four roles

| Role | Belongs to | In one line |
|---|---|---|
| **Super Admin** | The platform (no agency) | Runs the service: creates and pauses agencies, moves them between plans, sees non-personal platform numbers. Enters an agency's data only by an audited impersonation. |
| **Tenant Admin** | One agency | Owns the agency's workspace: people, all students and leads, reports, files, imports, automation, settings. |
| **Counselor** | One agency | Works their assigned students from first call to enrolment: stages, notes, calls, documents. |
| **Telecaller** | One agency | Works a call queue: logs call outcomes, books callbacks, sees only what a call needs. |

"Agency" and "workspace" are the same thing as the code's *tenant*. Everyone signs in with the agency's workspace
name, their email and their password; super admins leave the workspace empty.

## 2. What each role does

| | Tenant Admin | Counselor | Telecaller |
|---|---|---|---|
| **Lands on** | Dashboard (agency-wide) | Dashboard (own) | Follow-ups (own queue) |
| **Students and leads** | All; add, edit, delete, bulk reassign / stage / block | Own; add students (becomes theirs), edit, change stage | Own, reduced fields; mark potential/HOT, edit phone |
| **Calls** | Everyone's queue; schedule and log for anyone | Own leads' calls | Own calls: log outcomes, book the next call |
| **Web leads** | Whole inbox: review, convert, mark duplicate or spam | Those routed to them; take for themselves | — |
| **Documents** | Folder vault and every student's checklist | Documents of own leads | — |
| **Reports** | Funnel, sources, team, stage, follow-ups, for anyone | Own performance | Own performance |
| **Import / export** | Both | Export own leads | Export own leads, reduced columns |
| **Automation, settings, integrations, audit log, users** | Yes | — | — |
| **Usage and plan** | Sees the agency's plan and use (Settings) | — | — |
| **Own account** | Profile, password, two-step verification, sessions | same | same |

"Reduced fields" (telecallers): name, phone, stage, next call and notes. Address and email are hidden in the lead
page, lists, search and exports, by the same rule everywhere.

Two rules apply to every role:

1. **Records you do not own do not exist for you.** A counselor asking for another counselor's lead, or any agency's
   lead from another agency, gets "not found" (404), never "forbidden" — ids cannot be probed.
2. **The server decides.** Every API route names the action it performs and is refused before its body is read when
   the role may not do it; the interface hiding a button is a convenience, not the protection.

## 3. Adding and managing people (admins)

Users → New: name, email, role. The person gets an invitation link (by email when SMTP is configured; otherwise the
admin is shown the one-time link to pass on). The link sets the password.

| Action | Rules |
|---|---|
| **Change role** | Audited (`user.role_change`). The last active admin cannot be demoted or removed. |
| **Pause** (disable) | Sessions stop at the next request; they can be switched back on. Paused people do not count against the plan's user limit. |
| **Reset password** | An admin starts a reset for someone else; it signs that person out everywhere. |
| **Transfer leads** | Moves one person's active assignments and open calls to a colleague (audited). |
| **Delete** | Soft delete. Refused while the person still owns leads or open calls, and refused for yourself or the last admin. |

Plan limits apply to the number of active users (`SCALABILITY.md` §7): at the limit, adding or switching a person back
on is refused with a message that names the limit.

## 4. Signing in and staying safe

Every role gets the same protections (`SECURITY.md` §2.1): Argon2id passwords, lock-out after repeated failures with
the same answer for every kind of failure, sessions of 7 days (idle after 48 hours), a list of devices with "sign out
the others", and optional **two-step verification** (authenticator app plus ten one-time recovery codes).
Agencies can require it for chosen roles (`MFA_REQUIRED_ROLES`, recommended for admins and super admins); a required
role that has not set it up can only set it up or sign out.

## 5. Platform staff

Super admins use `/platform`: list agencies with their plan and use (users, leads, storage), create an agency (its
first admin gets an invitation link, and the agency starts in trial with the starter sources and the starter
automation rules), pause or resume it, change its plan (refused when the agency uses more than the new plan allows),
and see non-personal metrics. **Impersonating** an agency (to help with a problem) shows a banner, lasts until it is
stopped or the platform session ends (12 hours at most), writes an audit row at the start and at the end (in the
platform log and in the agency's), and tags every change made in between with the super admin's id. Two-step
verification applies to super admins like anyone else when the role is required to use it.

The first super admin is created from the server with `pnpm admin:create-superadmin` (`DEPLOYMENT.md` §3); there is
no signup page.

## 6. Machine callers

A website's **intake credential** is not a user and has no role. It can do one thing: create a web lead in its own
agency through `POST /api/webleads` or `/api/public/*`. It cannot read anything. Admins create, rotate (with a 24-hour
overlap) and revoke credentials in Settings → Website integrations.
