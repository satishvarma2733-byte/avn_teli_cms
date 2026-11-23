#!/bin/sh
# Build and (re)start aVn CMS on this server. Run from anywhere; it works in avn_cms/.
#
#   sh deploy/deploy.sh              # deploy what is checked out
#   AVN_VERSION=$(git rev-parse --short HEAD) sh deploy/deploy.sh     # also tag the image (for rollback)
#
# Order (docs/DEPLOYMENT.md §4): build -> migrate -> start web and worker -> health check.
# `up --wait` returns only when the containers are healthy, and the `migrate` service must have
# succeeded before web and worker start; if it fails, the old containers keep running.
set -eu
cd "$(dirname "$0")/.."

ENV_FILE=deploy/.env.production
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy deploy/.env.production.example and fill it in)." >&2; exit 1; }
for key in APP_HOST POSTGRES_PASSWORD AVN_APP_PASSWORD REDIS_PASSWORD SESSION_SECRET ENCRYPTION_KEY; do
  grep -Eq "^$key=.+" "$ENV_FILE" || { echo "$key is empty in $ENV_FILE." >&2; exit 1; }
done

compose() { docker compose -f deploy/docker-compose.prod.yml --env-file "$ENV_FILE" "$@"; }

compose build
compose up -d --remove-orphans --wait

# Through the proxy, the way a visitor sees it.
host=$(sed -n 's/^APP_HOST=//p' "$ENV_FILE" | head -n 1)
port=$(sed -n 's/^HTTPS_PORT=//p' "$ENV_FILE" | head -n 1)
url="https://$host${port:+:$port}/api/health"
echo "Checking $url"
# CURL_OPTS=-k lets a test on localhost accept Caddy's own local certificate; a real host needs nothing.
# shellcheck disable=SC2086
if ! curl --fail --silent --show-error --max-time 20 --retry 6 --retry-delay 5 --retry-connrefused ${CURL_OPTS:-} "$url"; then
  echo "The health check failed: the containers are up but $url does not answer 200. Not deployed." >&2
  echo "Look at: docker compose -f deploy/docker-compose.prod.yml --env-file $ENV_FILE logs web caddy" >&2
  exit 1
fi
echo
echo "Deployed ${AVN_VERSION:-latest}."
