#!/bin/sh
# Runs once, when the Postgres data volume is first created (the image runs everything in
# /docker-entrypoint-initdb.d). The owner role (POSTGRES_USER) owns the schema and runs the
# migrations. avn_app is what the application uses for tenant data: no ownership and no BYPASSRLS,
# so the row-level-security policies always apply to it. Its password comes from AVN_APP_PASSWORD
# (hex or base64url characters only, so it is safe inside this SQL string and a connection URL).
set -eu
case "${AVN_APP_PASSWORD:-}" in
  '' | *[!A-Za-z0-9_-]*) echo "AVN_APP_PASSWORD must be set and use only A-Z a-z 0-9 _ -" >&2; exit 1 ;;
esac
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE avn_app LOGIN PASSWORD '${AVN_APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SQL
