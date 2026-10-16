-- Documents vault (Phase 7): version series, checklist type, upload and scan tracking.
--
-- Edited by hand: Prisma wanted to drop "users_tenant_email_key" (its NULLS NOT DISTINCT is not
-- modelled in the schema), which would let two platform admins share an email; it stays. The new
-- required column is filled for any existing row before it becomes NOT NULL.

-- AlterEnum
ALTER TYPE "scan_status" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "doc_type" "student_doc_type",
ADD COLUMN     "purged_at" TIMESTAMPTZ(6),
ADD COLUMN     "scan_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scan_error" TEXT,
ADD COLUMN     "scan_signature" TEXT,
ADD COLUMN     "scanned_at" TIMESTAMPTZ(6),
ADD COLUMN     "series_id" UUID,
ADD COLUMN     "uploaded_at" TIMESTAMPTZ(6);

-- A document that existed before versions is the first version of its own series.
UPDATE "documents" SET "series_id" = "id" WHERE "series_id" IS NULL;
ALTER TABLE "documents" ALTER COLUMN "series_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "documents_tenant_id_series_id_version_idx" ON "documents"("tenant_id", "series_id", "version");

-- CreateIndex
CREATE INDEX "documents_tenant_id_scan_status_uploaded_at_idx" ON "documents"("tenant_id", "scan_status", "uploaded_at");
