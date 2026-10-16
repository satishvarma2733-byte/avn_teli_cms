-- CreateEnum
CREATE TYPE "file_purpose" AS ENUM ('IMPORT_UPLOAD', 'IMPORT_ERRORS', 'EXPORT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "job_status" ADD VALUE 'DRAFT';
ALTER TYPE "job_status" ADD VALUE 'VALIDATING';
ALTER TYPE "job_status" ADD VALUE 'VALIDATED';
ALTER TYPE "job_status" ADD VALUE 'CANCELED';

-- (Prisma generated `DROP INDEX "users_tenant_email_key"` here because it can't model
-- NULLS NOT DISTINCT; removed by hand. tests guard against this: db/src/migrations.test.ts.)

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purpose" "file_purpose" NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stored_files_tenant_id_purpose_created_at_idx" ON "stored_files"("tenant_id", "purpose", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stored_files_expires_at_idx" ON "stored_files"("expires_at");

-- ════════════════════════════════════════════════════════════════════════════
-- Hand-written: tenant isolation and grants for job files.
-- ════════════════════════════════════════════════════════════════════════════
GRANT SELECT, INSERT, UPDATE, DELETE ON "stored_files" TO avn_app;
ALTER TABLE "stored_files" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stored_files"
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
