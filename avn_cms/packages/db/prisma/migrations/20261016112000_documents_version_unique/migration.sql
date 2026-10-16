-- Two uploads of one document can never take the same version number.
-- (Replaces the plain index from documents_vault; no rows can violate it, versions are new.)

-- DropIndex
DROP INDEX "documents_tenant_id_series_id_version_idx";

-- CreateIndex
CREATE UNIQUE INDEX "documents_tenant_id_series_id_version_key" ON "documents"("tenant_id", "series_id", "version");
