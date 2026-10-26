-- Phase 10 (scale): searching students by name, parent's name or phone, as the application role.
--
-- Found by the load test at 1,000,000 leads (docs/SCALABILITY.md §4): under row-level security, Postgres
-- will not use a trigram index for LIKE/ILIKE. The operators behind them are not "leakproof", and a query
-- that has to enforce a row policy may only use an index for a condition whose operator is leakproof (it
-- could otherwise reveal rows the policy hides). So for the application role every search was a scan of the
-- whole students table (or of the whole leads table in date order), 0.7 to 6 seconds at a million leads,
-- although the same query as the table owner takes 7 ms.
--
-- This function does the matching as the owner (SECURITY DEFINER) and gives back only ids. It is as safe as
-- the policy it replaces, because it applies the same condition itself: only rows of the workspace set for
-- this connection (app_tenant_id(), the value the tenant-scoped client sets for every transaction; nothing
-- is returned when none is set), and only students that are not deleted. The term and the digits are bound
-- values, never put into SQL text; the only text built is a fixed choice between conditions. % and _ in the
-- term are matched literally. The search path is fixed so that nothing can be substituted for the tables it
-- reads. Only the application role may run it.
--
-- The query is built per call (EXECUTE) on purpose: planned with the actual search text, Postgres uses the
-- trigram indexes for a rare term and stops early for a common one. Planned once for any text it cannot.

CREATE OR REPLACE FUNCTION search_student_ids(
  term text,
  digits text,
  with_email boolean DEFAULT false,
  max_rows integer DEFAULT 2001
) RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  pattern text := '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  only_digits text := regexp_replace(coalesce(digits, ''), '\D', '', 'g');
  conditions text := 's.name ILIKE $1 OR s.parent_name ILIKE $1';
BEGIN
  IF length(only_digits) >= 4 THEN
    conditions := conditions || ' OR s.phone_e164 LIKE $2';
  END IF;
  IF with_email THEN
    conditions := conditions || ' OR s.email::text ILIKE $1';
  END IF;
  RETURN QUERY EXECUTE
    'SELECT s.id FROM students s WHERE s.tenant_id = app_tenant_id() AND s.deleted_at IS NULL AND ('
    || conditions || ') LIMIT $3'
    USING pattern, '%' || only_digits || '%', max_rows;
END
$$;

REVOKE ALL ON FUNCTION search_student_ids(text, text, boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_student_ids(text, text, boolean, integer) TO avn_app;
