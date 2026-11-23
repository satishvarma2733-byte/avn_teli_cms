#!/bin/sh
# Daily logical backup of the database (custom format, restorable with pg_restore), keeping the newest 14.
# Run from cron on the server, for example:   15 2 * * *  cd /srv/avn_cms && sh deploy/backup.sh
#
# This covers the database only. Documents live in the R2 bucket (copy that on its own schedule), and
# SESSION_SECRET / ENCRYPTION_KEY must be kept somewhere else: a backup restored without ENCRYPTION_KEY
# loses every authenticator. Copy $BACKUP_DIR off the server (rclone, scp, a snapshot): a backup that
# lives only on the machine it protects is not a backup. Restore and verify: docs/RUNBOOK.md §5.
set -eu
cd "$(dirname "$0")/.."

BACKUP_DIR=${BACKUP_DIR:-backups}
KEEP=${KEEP:-14}
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/avn_cms-$(date +%Y-%m-%d-%H%M).dump"

docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production \
  exec -T postgres pg_dump --username avn_owner --format custom avn_cms > "$file.partial"
mv "$file.partial" "$file"
echo "Wrote $file ($(wc -c < "$file") bytes)"

# Remove the oldest beyond KEEP.
ls -1t "$BACKUP_DIR"/avn_cms-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f -- "$old"
  echo "Removed $old"
done
