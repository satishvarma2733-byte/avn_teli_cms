# AI roadmap — aVn CMS

> Where AI could help an admissions team, in what order, and the rules it would have to follow in a system that holds
> children's and families' personal data. **Nothing here is built.** No AI provider, model or agent is part of the
> product (`PROJECT_AUDIT.md` §4); this document exists so that when a decision is made, the data model, privacy
> boundary and tests are already thought through. Items are ordered by value for effort, not by date.

## 1. What the data already supports

aVn CMS records, per lead: stage history with timestamps, every call with outcome and note, notes, source, interest,
assignee, documents checklist state, and the final result (enrolled or closed with a reason). That is enough for
simple, explainable models once an agency has a few thousand closed leads, and for language assistance on day one.

## 2. Candidates

### A. Assist the person (suggestions a human accepts)

| # | Feature | Input → output | Value | Needs |
|---|---|---|---|---|
| A1 | **Lead score** | Source, interest, response speed, calls tried, days in stage, NEET score if captured → probability of enrolment, with the top reasons | Telecallers call the likely ones first | ≥ 2,000 closed leads per agency, or a pooled model with agencies' consent; a logistic or gradient-boosted model, not an LLM |
| A2 | **Next best action** | Lead timeline → "Call now: asked for a callback today", "Chase documents: 9 days since offer" | Fewer cold leads | Rules first (days-in-stage thresholds), model later |
| A3 | **Call and note summary** | A telecaller's free-text notes → a two-line summary and a suggested disposition | Faster logging, cleaner history | LLM; text only |
| A4 | **Message drafts** | Lead context + template → a WhatsApp or email draft in the family's language | Consistent, quicker replies | WhatsApp/email integration first (`IMPROVEMENT_ROADMAP.md` #12–13) |
| A5 | **Smarter duplicate detection** | Name, parent, phone, place → likely same person | Cleaner data | Fuzzy matching (trigram similarity is already in the database) before any model |
| A6 | **Natural-language search and report questions** | "Counselors with the most enrolments from Meta last quarter" → a filter or report | Owners without spreadsheets | LLM that writes a *query over the existing report API*, never SQL |

### B. Process documents

| # | Feature | Notes |
|---|---|---|
| B1 | **Document check** | OCR a passport or mark sheet; compare name, date of birth, marks with the student record; flag mismatches for a human to verify (the checklist already has verify/reject) |
| B2 | **Document type detection** | Put an upload in the right checklist slot |
| B3 | **Redaction** | Mask identifiers before a file is shared with a university |

### C. Act for the person (needs the strictest controls)

| # | Feature | Notes |
|---|---|---|
| C1 | **Web-lead triage agent** | Reads a new enquiry, flags spam, finds the duplicate, proposes the counselor and the first message; a human approves until accuracy is proven |
| C2 | **Call transcription → structured outcome** | Needs telephony with recordings and consent from the family; outputs go to the same disposition fields, marked "suggested by AI" |
| C3 | **Enrolment forecast** | Weekly projection by source and counselor from pipeline and history |

## 3. Rules every AI feature must follow

1. **The tenant boundary holds.** A model, a prompt or a retrieval index only ever sees one agency's data. No shared
   fine-tuning on raw records; a pooled model (A1) uses de-identified features and needs written agency consent.
2. **Minimum data.** Send the provider only the fields the task needs (notes, not phone numbers; scores, not names).
   Telecallers' reduced field set (`USER_ROLES.md` §2) is the default for any feature that runs on their behalf.
3. **Provider terms.** Use a provider under a data-processing agreement with no training on inputs, and with a region
   that suits the agency's obligations (India's DPDP Act; some agencies serve EU/UK families). A provider is an
   *owner decision* and a sub-processor the agencies must be told about.
4. **A human decides.** Suggestions are labelled, can be dismissed, and never change a stage, send a message or delete
   anything without a person's action (until a specific automation is switched on by an admin, per rule, per agency).
5. **Everything is recorded.** Accepted suggestions appear in the audit log and the timeline as "suggested by AI,
   accepted by <person>", with the model and version; rejected ones are counted (to measure usefulness) but not stored
   with content.
6. **Explainable.** A score shows its top reasons. If it cannot be explained to a counselor in a sentence, it does not
   ship.
7. **Measured before trusted.** Each feature has an offline evaluation on held-out closed leads (or a labelled sample)
   and an online test (counselors with and without), with a target agreed beforehand. Fairness check: no use of
   caste, religion, gender, or proxies for them; review score differences by state and source.
8. **Cost and limits.** AI use is metered like any other usage (`SCALABILITY.md` §7): a plan limit, a per-agency daily
   cap, and a kill switch per agency and globally.
9. **Prompt-injection hygiene.** Anything a family types (web-lead messages, notes) is data to the model, never
   instructions: it is quoted, length-limited, and the model has no tools beyond the narrow action it was asked for.
10. **Degrade gracefully.** If the provider is down or slow, the page works exactly as it does today.

## 4. Suggested order

1. **A2 with rules** (no model): days-in-stage and callback signals on the dashboard and queue.
2. **A5 fuzzy duplicates**, using the database.
3. **A3 summaries** for notes, as the first LLM feature, behind a per-agency switch, after the provider and DPA are
   chosen.
4. **A1 lead score** once an agency has the history; start with the largest agency and measure the lift in contact
   rate before rolling out.
5. **B1/B2** with a human verifying every result.
6. **C1** only after A3 and A1 have a record of accuracy.

## 5. What has to exist first

- A provider decision and a data-processing agreement (owner).
- WhatsApp/email integration for A4; telephony with recordings for C2.
- An evaluation harness in the repository (labelled examples, a script, a pass bar) so every change to a prompt or a
  model is tested like code.
- A consent statement in the agency's terms and a line in the families' enquiry form where recordings are involved.
