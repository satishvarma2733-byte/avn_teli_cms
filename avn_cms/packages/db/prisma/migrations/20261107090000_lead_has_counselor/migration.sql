-- The "Unassigned" leads view (docs/SCALABILITY.md §8). "Unassigned" means no active counselor assignment,
-- which lives in another table, so the view was an anti-join: walk the leads newest first and look each one
-- up. When few or no leads are unassigned that walk covers every lead (2.4 s at 1,000,000).
--
-- Each lead now carries `has_counselor`, kept by the database itself: a trigger on "lead_assignments"
-- recomputes it for the leads a statement touched, so every way of assigning (screens, imports, automation,
-- round robin, transfers) keeps it right without any application code. The view reads a partial index of
-- just the leads without a counselor.
--
-- Edited by hand: the trigger and the partial index cannot be written in the Prisma schema. On a database
-- that already holds a lot of data the backfill rewrites every lead once; run it in a quiet moment.

ALTER TABLE "leads" ADD COLUMN "has_counselor" BOOLEAN NOT NULL DEFAULT false;

UPDATE "leads" AS l
SET "has_counselor" = true
WHERE EXISTS (
  SELECT 1 FROM "lead_assignments" AS a
  WHERE a."lead_id" = l."id" AND a."is_active" AND a."role_function" = 'COUNSELOR'
);

-- Recomputes the flag of the given leads, writing only those whose flag really changes. It runs as the
-- caller: inside a workspace's transaction row-level security keeps it to that workspace's leads, which
-- are the only ones its assignments can name.
CREATE FUNCTION lead_counselor_flag_recompute(lead_ids uuid[]) RETURNS void
LANGUAGE sql
AS $$
  UPDATE "leads" AS l
  SET "has_counselor" = x.flag
  FROM (
    SELECT c.id AS lead_id, EXISTS (
      SELECT 1 FROM "lead_assignments" AS a
      WHERE a."lead_id" = c.id AND a."is_active" AND a."role_function" = 'COUNSELOR'
    ) AS flag
    FROM unnest(lead_ids) AS c(id)
  ) AS x
  WHERE l."id" = x.lead_id AND l."has_counselor" IS DISTINCT FROM x.flag;
$$;
REVOKE ALL ON FUNCTION lead_counselor_flag_recompute(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lead_counselor_flag_recompute(uuid[]) TO avn_app;

-- Once per statement, not per row (an import assigns 500 leads in one statement). An update covers the
-- lead before and after, in case an assignment is ever moved to another lead.
CREATE FUNCTION lead_counselor_flag_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lead_counselor_flag_recompute(ARRAY(SELECT DISTINCT "lead_id" FROM new_rows));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM lead_counselor_flag_recompute(ARRAY(SELECT DISTINCT "lead_id" FROM old_rows));
  ELSE
    PERFORM lead_counselor_flag_recompute(
      ARRAY(SELECT "lead_id" FROM new_rows UNION SELECT "lead_id" FROM old_rows)
    );
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "lead_assignments_counselor_flag_ins" AFTER INSERT ON "lead_assignments"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION lead_counselor_flag_sync();
CREATE TRIGGER "lead_assignments_counselor_flag_upd" AFTER UPDATE ON "lead_assignments"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lead_counselor_flag_sync();
CREATE TRIGGER "lead_assignments_counselor_flag_del" AFTER DELETE ON "lead_assignments"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION lead_counselor_flag_sync();

-- Newest first, like the leads list, over just the live leads without a counselor.
CREATE INDEX IF NOT EXISTS "leads_unassigned_idx" ON "leads" ("tenant_id", "created_at" DESC, "id")
  WHERE NOT "has_counselor" AND "deleted_at" IS NULL;
