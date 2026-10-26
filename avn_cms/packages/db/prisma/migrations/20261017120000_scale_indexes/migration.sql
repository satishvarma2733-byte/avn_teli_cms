-- Phase 10 (scale): indexes found by the load test at 1,000,000 leads (docs/SCALABILITY.md).
--
-- Edited by hand: Prisma wanted to drop "users_tenant_email_key" (its NULLS NOT DISTINCT is not
-- modelled in the schema), which would let two platform admins share an email; it stays. The partial and
-- covering indexes below cannot be written in the schema either.
--
-- On a database that already holds a lot of data, build these first with CREATE INDEX CONCURRENTLY (the
-- same statements, run by hand outside a transaction, docs/DEPLOYMENT.md §4); IF NOT EXISTS then makes this
-- migration a no-op instead of a long lock on writes.

-- Searching students by parent's name was a full scan of the students table (400 ms at 1.2M rows): the
-- name and phone searches already had trigram indexes, so the OR across the three could not use them.
CREATE INDEX IF NOT EXISTS "students_parent_name_trgm" ON "students" USING GIN ("parent_name" gin_trgm_ops);

-- The conversion funnel reads, for every lead, the furthest stage it ever reached. Index-only, in lead order.
CREATE INDEX IF NOT EXISTS "lead_status_history_funnel_idx" ON "lead_status_history" ("tenant_id", "lead_id") INCLUDE ("to_stage");

-- The dashboard counts calls finished in the last week across a whole workspace. Open calls already have
-- "follow_ups_tenant_open"; finished ones are mostly old, so they get an index of just the finished rows.
CREATE INDEX IF NOT EXISTS "follow_ups_done_idx" ON "follow_ups" ("tenant_id", "completed_at") WHERE "completed_at" IS NOT NULL;
