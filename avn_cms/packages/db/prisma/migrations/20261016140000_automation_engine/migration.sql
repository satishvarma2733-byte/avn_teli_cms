-- Automation engine (Phase 8): rule starter keys, run bookkeeping, and web-lead routing.
--
-- Edited by hand: Prisma wanted to drop "users_tenant_email_key" (its NULLS NOT DISTINCT is not
-- modelled in the schema), which would let two platform admins share an email; it stays. The new
-- required run column is filled for any existing row before it becomes NOT NULL.

-- AlterTable
ALTER TABLE "automation_rules" ADD COLUMN     "starter_key" TEXT;

-- AlterTable
ALTER TABLE "automation_runs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dedupe_key" TEXT,
ADD COLUMN     "finished_at" TIMESTAMPTZ(6),
ADD COLUMN     "payload" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "started_at" TIMESTAMPTZ(6);

UPDATE "automation_runs" SET "dedupe_key" = "id"::text WHERE "dedupe_key" IS NULL;
ALTER TABLE "automation_runs" ALTER COLUMN "dedupe_key" SET NOT NULL;

-- AlterTable
ALTER TABLE "web_leads" ADD COLUMN     "routed_at" TIMESTAMPTZ(6),
ADD COLUMN     "routed_to_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "automation_rules_tenant_id_starter_key_key" ON "automation_rules"("tenant_id", "starter_key");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_status_created_at_idx" ON "automation_runs"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_tenant_id_rule_id_dedupe_key_key" ON "automation_runs"("tenant_id", "rule_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "web_leads_tenant_id_routed_to_id_status_idx" ON "web_leads"("tenant_id", "routed_to_id", "status");

-- Escalating overdue calls used to be built into the worker (after a fixed 24 hours). It is now a
-- rule like any other, so every existing workspace gets that one rule and nothing changes for them.
-- The other starter rules are added by an admin from the Automations page.
INSERT INTO "automation_rules"
  ("id", "tenant_id", "name", "is_active", "trigger", "conditions", "actions", "starter_key", "created_at", "updated_at")
SELECT gen_random_uuid(), t."id", 'Escalate calls that are 24 hours overdue', true,
       'FOLLOWUP_OVERDUE'::"automation_trigger",
       '{"minutesOverdue":1440}'::jsonb,
       '[{"type":"escalate"}]'::jsonb,
       'escalate_overdue', now(), now()
FROM "tenants" t
ON CONFLICT ("tenant_id", "starter_key") DO NOTHING;
