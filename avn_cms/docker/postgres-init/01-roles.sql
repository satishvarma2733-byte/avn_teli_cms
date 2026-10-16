-- Runs once, when the local Postgres volume is first created.
-- avn_owner (POSTGRES_USER) owns the schema and runs migrations; it bypasses RLS as table owner.
-- avn_app is what the application uses for tenant data: no ownership, no BYPASSRLS,
-- so the row-level-security policies always apply to it.
CREATE ROLE avn_app LOGIN PASSWORD 'avn_app_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Separate database for automated tests (reset freely by the test setup).
CREATE DATABASE avn_cms_test OWNER avn_owner;
