-- (Prisma generated `DROP INDEX "users_tenant_email_key"` here because it can't model
-- NULLS NOT DISTINCT; removed by hand. tests guard against this: db/src/migrations.test.ts.)

-- AlterTable
ALTER TABLE "export_jobs" ADD COLUMN     "heartbeat_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "heartbeat_at" TIMESTAMPTZ(6);
