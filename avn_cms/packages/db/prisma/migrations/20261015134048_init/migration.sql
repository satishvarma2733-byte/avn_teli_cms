-- Extensions: citext (case-insensitive emails), pg_trgm (fuzzy name/phone search).
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'TRIAL');

-- CreateEnum
CREATE TYPE "role_code" AS ENUM ('SUPER_ADMIN', 'TENANT_ADMIN', 'COUNSELOR', 'TELECALLER');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "plan_code" AS ENUM ('STARTER', 'PROFESSIONAL', 'ULTRA', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "lead_stage" AS ENUM ('NEW', 'CONTACTED', 'INTERESTED', 'FOLLOW_UP_REQUIRED', 'POTENTIAL', 'APPLICATION_STARTED', 'DOCUMENTS_PENDING', 'APPLICATION_SUBMITTED', 'OFFER_RECEIVED', 'ADMISSION_CONFIRMED', 'ENROLLED', 'NOT_INTERESTED', 'INVALID', 'UNREACHABLE', 'DUPLICATE', 'BLOCKED', 'LOST', 'LONG_TERM');

-- CreateEnum
CREATE TYPE "call_disposition" AS ENUM ('SCHEDULED', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'CALL_BACK_LATER', 'INTERESTED', 'NOT_INTERESTED', 'AWAITING_FEEDBACK', 'ESCALATED');

-- CreateEnum
CREATE TYPE "priority" AS ENUM ('NORMAL', 'HOT');

-- CreateEnum
CREATE TYPE "role_function" AS ENUM ('COUNSELOR', 'TELECALLER');

-- CreateEnum
CREATE TYPE "activity_type" AS ENUM ('CALL', 'WHATSAPP', 'EMAIL', 'SMS', 'NOTE', 'STATUS_CHANGE', 'ASSIGNMENT', 'DOCUMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "web_lead_status" AS ENUM ('NEW', 'DUPLICATE', 'CONVERTED', 'SPAM', 'REJECTED');

-- CreateEnum
CREATE TYPE "intake_channel" AS ENUM ('PUBLIC_API', 'WEBHOOK', 'LEADXP_COMPAT', 'IMPORT');

-- CreateEnum
CREATE TYPE "scan_status" AS ENUM ('PENDING', 'CLEAN', 'INFECTED');

-- CreateEnum
CREATE TYPE "student_doc_type" AS ENUM ('PASSPORT', 'MARKS_MEMO', 'NEET_RESULT', 'TRANSFER_CERT', 'PHOTO', 'ADMISSION_LETTER', 'VISA', 'PAYMENT_RECEIPT', 'OTHER');

-- CreateEnum
CREATE TYPE "student_doc_status" AS ENUM ('MISSING', 'UPLOADED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "automation_trigger" AS ENUM ('WEB_LEAD_CREATED', 'LEAD_UNCONTACTED', 'FOLLOWUP_OVERDUE', 'STAGE_CHANGED');

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" "plan_code" NOT NULL,
    "name" TEXT NOT NULL,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "price_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" "role_code" NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'TRIAL',
    "plan_id" UUID,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'ACTIVE',
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "role_code" "role_code" NOT NULL,
    "name" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "phone_e164" TEXT,
    "password_hash" TEXT NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "mfa_secret" TEXT,
    "mfa_enabled_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_round_robin_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_secret" TEXT NOT NULL,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT true,
    "acting_tenant_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parent_name" TEXT,
    "phone_raw" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "alt_phone_e164" TEXT,
    "email" CITEXT,
    "town" TEXT,
    "district" TEXT,
    "state" TEXT,
    "address" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "stage" "lead_stage" NOT NULL DEFAULT 'NEW',
    "is_potential" BOOLEAN NOT NULL DEFAULT false,
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "interest_country" TEXT,
    "interest_course" TEXT,
    "next_call_at" TIMESTAMPTZ(6),
    "last_contacted_at" TIMESTAMPTZ(6),
    "lost_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "assignee_id" UUID NOT NULL,
    "role_function" "role_function" NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_stage" "lead_stage",
    "to_stage" "lead_stage" NOT NULL,
    "changed_by_id" UUID,
    "note" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_ups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "assignee_id" UUID NOT NULL,
    "disposition" "call_disposition" NOT NULL DEFAULT 'SCHEDULED',
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "outcome_note" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "is_overdue" BOOLEAN NOT NULL DEFAULT false,
    "escalated_to" UUID,
    "escalated_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID,
    "student_id" UUID NOT NULL,
    "type" "activity_type" NOT NULL,
    "actor_id" UUID,
    "channel" TEXT,
    "direction" "direction",
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "previous_secret_hash" TEXT,
    "previous_valid_until" TIMESTAMPTZ(6),
    "default_source_id" UUID,
    "rate_limit_per_min" INTEGER NOT NULL DEFAULT 120,
    "last_used_at" TIMESTAMPTZ(6),
    "use_count" BIGINT NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "intake_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "web_leads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_raw" TEXT NOT NULL,
    "phone_e164" TEXT,
    "email" CITEXT,
    "interest_country" TEXT,
    "interest_course" TEXT,
    "message" TEXT,
    "source_id" UUID,
    "source_label" TEXT,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "web_lead_status" NOT NULL DEFAULT 'NEW',
    "dedupe_match_student_id" UUID,
    "converted_lead_id" UUID,
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "intake_channel" "intake_channel" NOT NULL DEFAULT 'PUBLIC_API',
    "intake_credential_id" UUID,
    "city" TEXT,
    "neet_score" INTEGER,
    "neet_status" TEXT,
    "education" TEXT,
    "education_group" TEXT,
    "submitted_by" TEXT,
    "post_slug" TEXT,
    "gclid" TEXT,
    "campaign_id" TEXT,
    "page_url" TEXT,
    "landing_page" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "form_id" TEXT,
    "session_id" TEXT,
    "quality_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "idempotency_key" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "folder_id" UUID,
    "student_id" UUID,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "scan_status" "scan_status" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "doc_type" "student_doc_type" NOT NULL,
    "document_id" UUID,
    "status" "student_doc_status" NOT NULL DEFAULT 'MISSING',
    "reviewed_by_id" UUID,
    "note" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "student_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'QUEUED',
    "params" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "file_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'QUEUED',
    "params" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "file_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entity_type" TEXT,
    "entity_id" UUID,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "automation_trigger" NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "entity_id" UUID,
    "status" TEXT NOT NULL,
    "result" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "impersonated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "subscriptions_tenant_id_idx" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_tenant_id_metric_period_key" ON "usage_counters"("tenant_id", "metric", "period");

-- CreateIndex
CREATE INDEX "users_tenant_id_role_code_status_idx" ON "users"("tenant_id", "role_code", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_tenant_id_code_key" ON "lead_sources"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "students_tenant_id_phone_e164_idx" ON "students"("tenant_id", "phone_e164");

-- CreateIndex
CREATE INDEX "students_tenant_id_email_idx" ON "students"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "students_tenant_id_state_district_idx" ON "students"("tenant_id", "state", "district");

-- CreateIndex
CREATE INDEX "students_tenant_id_created_at_id_idx" ON "students"("tenant_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_stage_idx" ON "leads"("tenant_id", "stage");

-- CreateIndex
CREATE INDEX "leads_tenant_id_created_at_id_idx" ON "leads"("tenant_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_student_id_idx" ON "leads"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_source_id_idx" ON "leads"("tenant_id", "source_id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_next_call_at_idx" ON "leads"("tenant_id", "next_call_at");

-- CreateIndex
CREATE INDEX "lead_assignments_tenant_id_assignee_id_is_active_idx" ON "lead_assignments"("tenant_id", "assignee_id", "is_active");

-- CreateIndex
CREATE INDEX "lead_assignments_tenant_id_lead_id_idx" ON "lead_assignments"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "lead_status_history_tenant_id_lead_id_created_at_idx" ON "lead_status_history"("tenant_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_status_history_tenant_id_to_stage_created_at_idx" ON "lead_status_history"("tenant_id", "to_stage", "created_at");

-- CreateIndex
CREATE INDEX "follow_ups_tenant_id_assignee_id_scheduled_at_idx" ON "follow_ups"("tenant_id", "assignee_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "follow_ups_tenant_id_lead_id_idx" ON "follow_ups"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "activities_tenant_id_student_id_created_at_idx" ON "activities"("tenant_id", "student_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "activities_tenant_id_lead_id_created_at_idx" ON "activities"("tenant_id", "lead_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "activities_tenant_id_created_at_idx" ON "activities"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notes_tenant_id_lead_id_created_at_idx" ON "notes"("tenant_id", "lead_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "intake_credentials_username_key" ON "intake_credentials"("username");

-- CreateIndex
CREATE INDEX "intake_credentials_tenant_id_idx" ON "intake_credentials"("tenant_id");

-- CreateIndex
CREATE INDEX "web_leads_tenant_id_status_submitted_at_idx" ON "web_leads"("tenant_id", "status", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "web_leads_tenant_id_phone_e164_idx" ON "web_leads"("tenant_id", "phone_e164");

-- CreateIndex
CREATE INDEX "web_leads_tenant_id_utm_campaign_idx" ON "web_leads"("tenant_id", "utm_campaign");

-- CreateIndex
CREATE INDEX "web_leads_tenant_id_source_label_idx" ON "web_leads"("tenant_id", "source_label");

-- CreateIndex
CREATE INDEX "folders_tenant_id_parent_id_idx" ON "folders"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "documents_tenant_id_folder_id_idx" ON "documents"("tenant_id", "folder_id");

-- CreateIndex
CREATE INDEX "documents_tenant_id_student_id_idx" ON "documents"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_documents_tenant_id_student_id_doc_type_key" ON "student_documents"("tenant_id", "student_id", "doc_type");

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_created_at_idx" ON "import_jobs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "export_jobs_tenant_id_created_at_idx" ON "export_jobs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_read_at_created_at_idx" ON "notifications"("tenant_id", "user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "automation_rules_tenant_id_trigger_is_active_idx" ON "automation_rules"("tenant_id", "trigger", "is_active");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_rule_id_created_at_idx" ON "automation_runs"("tenant_id", "rule_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_created_at_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "lead_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_credentials" ADD CONSTRAINT "intake_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_leads" ADD CONSTRAINT "web_leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_leads" ADD CONSTRAINT "web_leads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_leads" ADD CONSTRAINT "web_leads_intake_credential_id_fkey" FOREIGN KEY ("intake_credential_id") REFERENCES "intake_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- Hand-written: indexes Prisma can't express, the application role, grants and
-- row-level security (docs/ARCHITECTURE.md §2, docs/DATABASE_SCHEMA.md).
-- ════════════════════════════════════════════════════════════════════════════

-- Email unique per tenant; platform users (tenant_id NULL) are unique among themselves.
CREATE UNIQUE INDEX "users_tenant_email_key" ON "users" ("tenant_id", "email") NULLS NOT DISTINCT;

-- One live student per phone per tenant (the dedupe key); soft-deleted rows don't count.
CREATE UNIQUE INDEX "students_tenant_phone_active_key" ON "students" ("tenant_id", "phone_e164") WHERE "deleted_at" IS NULL;

-- One active owner per lead and function; history rows have is_active = false.
CREATE UNIQUE INDEX "lead_assignments_active_key" ON "lead_assignments" ("lead_id", "role_function") WHERE "is_active";

-- Hot query shapes.
CREATE INDEX "students_name_trgm" ON "students" USING gin ("name" gin_trgm_ops);
CREATE INDEX "students_phone_trgm" ON "students" USING gin ("phone_e164" gin_trgm_ops);
CREATE INDEX "leads_tenant_potential" ON "leads" ("tenant_id", "is_potential") WHERE "is_potential";
CREATE INDEX "leads_tenant_hot" ON "leads" ("tenant_id", "priority") WHERE "priority" = 'HOT';
CREATE INDEX "follow_ups_tenant_open" ON "follow_ups" ("tenant_id", "scheduled_at") WHERE "completed_at" IS NULL;
CREATE UNIQUE INDEX "web_leads_idempotency_key" ON "web_leads" ("tenant_id", "intake_credential_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX "intake_credentials_active" ON "intake_credentials" ("tenant_id") WHERE "revoked_at" IS NULL;

-- The application role. Created NOLOGIN if missing so grants never fail; the operator gives it
-- LOGIN + a password (see docs/DEPLOYMENT.md). It never owns tables and has no BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avn_app') THEN
    CREATE ROLE avn_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO avn_app;

-- The tenant the current transaction acts for; NULL when unset (then every policy hides all rows).
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app_tenant_id() TO avn_app;

-- Global catalogs: read-only.
GRANT SELECT ON "plans", "roles" TO avn_app;

-- A tenant sees and edits only its own tenant row.
GRANT SELECT, UPDATE ON "tenants" TO avn_app;
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenants" USING ("id" = app_tenant_id()) WITH CHECK ("id" = app_tenant_id());

-- Users: tenant-scoped; never hard-deleted by the app (soft delete + transfer-on-delete).
GRANT SELECT, INSERT, UPDATE ON "users" TO avn_app;

-- Append-only tables: no UPDATE/DELETE for the application, enforced by the database.
GRANT SELECT, INSERT ON "activities", "lead_status_history", "audit_logs" TO avn_app;

-- Ordinary tenant tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "lead_sources", "students", "leads", "lead_assignments", "follow_ups", "notes",
  "intake_credentials", "web_leads", "folders", "documents", "student_documents",
  "import_jobs", "export_jobs", "notifications", "automation_rules", "automation_runs",
  "subscriptions", "usage_counters"
TO avn_app;

-- sessions, password_reset_tokens and _prisma_migrations: no grant (owner-only, packages/auth).

-- Row-level security on every tenant-owned table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'lead_sources', 'students', 'leads', 'lead_assignments', 'lead_status_history',
    'follow_ups', 'activities', 'notes', 'intake_credentials', 'web_leads', 'folders',
    'documents', 'student_documents', 'import_jobs', 'export_jobs', 'notifications',
    'automation_rules', 'automation_runs', 'audit_logs', 'subscriptions', 'usage_counters'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())',
      t
    );
  END LOOP;
END $$;
