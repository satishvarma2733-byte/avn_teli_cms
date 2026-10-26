# Product overview — aVn CMS

> What the product is, who it is for, and where it stands. For the full feature list and status see `FEATURES.md`;
> for the people who use it, `USER_ROLES.md`; for how it is built, `ARCHITECTURE.md`.

## 1. In one paragraph

aVn CMS is a multi-tenant CRM for overseas-education consultancies (MBBS abroad and similar). An **agency**
(consultancy) gets its own private workspace where student enquiries from ads, websites, spreadsheets and manual entry
are collected, assigned to **counselors** and **telecallers**, worked through a disciplined **call queue**, followed
from first contact to **enrolment**, and measured: conversion by stage, by source and by person. Many agencies share
one deployment; none can see another's data.

It is a ground-up rebuild of the agency's existing LeadXP-based tool (`leadxp.aikosoft.ai`), keeping what works —
the follow-up queue, inline reassignment, source tagging, the web-leads inbox, and the intake endpoint the websites
already post to — and fixing what the review found missing (`PROJECT_AUDIT.md`).

## 2. Who it is for

| Who | What they get |
|---|---|
| **Agency owner / manager** (Tenant Admin) | One place to see every lead and call, who is behind, which source pays off, and who converts. Controls people, imports, automation, documents and settings. |
| **Counselor** | Their own students, a timeline of everything that happened with each, scheduled calls, a documents checklist, and their own numbers. |
| **Telecaller** | A focused daily queue (today, overdue, callbacks), one-tap outcome logging, only the student data a call needs. |
| **Platform operator** (Super Admin) | Creates and pauses agencies, assigns plans, watches usage, helps with audited impersonation. |

## 3. The working day

1. **Leads arrive.** Websites post enquiries to the intake endpoint; ads, events and walk-ins are typed in or imported
   from CSV/XLSX. Duplicates are caught by phone number.
2. **They are routed.** Round-robin or admin assignment gives each lead a counselor and, if wanted, a telecaller;
   automation rules can do it for web leads and notify a manager about leads nobody has called.
3. **Calls get made.** The telecaller works Today / Overdue; each call ends with an outcome (no answer, call back,
   interested, …) that updates the lead, the timeline and the next call. Calls that are missed escalate.
4. **Leads move.** Counselors take students through the pipeline — contacted, interested, application, documents,
   offer, admission confirmed, enrolled — or close them with a reason. Documents are collected in a per-student
   checklist with virus scanning.
5. **The owner measures.** Dashboard and reports show funnel, source performance, team leaderboard, overdue work.

## 4. What makes it safe to share one system

- **Tenant isolation at three layers:** the workspace comes from the session only, every query goes through a
  tenant-scoped data client, and the database enforces row-level security as a backstop.
- **Roles enforced on the server** for every request; records you do not own answer "not found".
- **An audit trail** for every change, and a timeline per student (`AUDIT_LOGGING.md`).
- **Security controls** from sign-in to uploads (`SECURITY.md`): two-step verification, lock-out, CSRF and CSP,
  virus-scanned documents, signed and expiring downloads, formula-safe spreadsheets.

## 5. Plans

Plans are loosely coupled to the product: a plan is a name and a set of limits (users, leads, stored documents).
Starter, Professional, Ultra and Enterprise exist as tiers; a missing limit means unlimited. Limits are enforced where
things are added, shown to the agency admin on Settings, and measured monthly for billing. There is **no payment
integration**: invoicing is outside the product for now (`SCALABILITY.md` §7, `IMPROVEMENT_ROADMAP.md`).

## 6. Scale

Designed and load-tested for an agency with **one million leads** and a staff of 150 working at once, on one database
server and one web server (`SCALABILITY.md`). Typical agencies are two orders of magnitude smaller.

## 7. Status and boundaries

Phases 1–9 are built and verified locally; Phase 10 (production readiness) is this release. Not yet in the product,
by decision or because a provider must be chosen first:

- Telephony (click-to-call is a `tel:` link), WhatsApp, SMS, email campaigns — each needs a provider decision.
- Payments and invoicing; the plan model and usage metering are ready for them.
- AI features (`AI_ROADMAP.md`).
- Switching the existing websites to the new intake endpoint: the endpoint is LeadXP-compatible and tested, but no
  website was changed (`WEBLEADS_COMPATIBILITY.md`).

No hosting target has been chosen and an independent penetration test is still to be done (`BUILD_STATUS.md`).
