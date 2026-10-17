-- Security hardening (Phase 9): second-factor protection and least-privilege access to credentials.
--
-- Edited by hand: Prisma wanted to drop "users_tenant_email_key" (its NULLS NOT DISTINCT is not
-- modelled in the schema), which would let two platform admins share an email; it stays.

-- Replay protection and attempt limiting for the second factor.
ALTER TABLE "users" ADD COLUMN     "mfa_failed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfa_last_step" INTEGER,
ADD COLUMN     "mfa_locked_until" TIMESTAMPTZ(6);

-- One-time recovery codes (keyed hashes only). Owner-only, like sessions: no grant to avn_app.
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes"("code_hash");
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes"("user_id");

ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The application role (tenant data, row-level security) can no longer read or change credentials
-- on users: password hashes, MFA secrets and the lock counters belong to packages/auth, which uses
-- the owner role. A flaw in tenant code can therefore not dump or overwrite them.
-- INSERT stays whole-row: inviting a user stores an unusable placeholder hash.
REVOKE SELECT, UPDATE ON "users" FROM avn_app;
GRANT SELECT ("id", "tenant_id", "role_code", "name", "email", "phone_e164", "status",
              "mfa_enabled_at", "last_login_at", "last_round_robin_at", "created_at", "updated_at",
              "deleted_at") ON "users" TO avn_app;
GRANT UPDATE ("name", "email", "phone_e164", "role_code", "status", "last_round_robin_at",
              "deleted_at", "updated_at") ON "users" TO avn_app;
