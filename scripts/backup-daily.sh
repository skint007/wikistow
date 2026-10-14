#!/bin/sh
# Run backup.sh once a day and keep the last 14 days, as docs/operations.md
# asks. Meant for a long-running container of the database's Postgres image,
# with the same settings and mounts as a one-off backup:
#
#   DATABASE_URL=postgres://wikistow@db:5432/wikistow PGPASSWORD=... \
#     BLOB_DIR=/data/blobs BACKUP_AT=03:17 backup-daily.sh /backups
#
# BACKUP_AT is a UTC time of day. It backs up at once when no successful
# backup started since the last BACKUP_AT, so a new container, or one stopped
# through that time, doesn't wait a day. Each success writes the time it
# started to <dir>/.last-success; `backup-daily.sh --check <dir>` fails once
# that is more than 26 hours old, for a container healthcheck, so a backup
# that keeps failing shows up.
set -u

dir=${2:-${1:-}}
if [ -z "$dir" ] || { [ $# -eq 2 ] && [ "$1" != --check ]; } || [ $# -gt 2 ]; then
  echo "usage: $0 [--check] <directory to write backups in>" >&2
  exit 2
fi
here=$(dirname "$0")
day=86400

# When the newest successful backup started, or 0 when the file is missing or
# holds anything but a plain number: arithmetic on that would end the shell.
last_success() {
  last=$(cat "$dir/.last-success" 2>/dev/null)
  case $last in
    '' | *[!0-9]* | 0?*) last=0 ;;
  esac
  echo "$last"
}

if [ "$1" = --check ]; then
  age=$(($(date -u +%s) - $(last_success)))
  if [ "$age" -gt $((day + 2 * 3600)) ]; then
    echo "No successful backup in the last 26 hours." >&2
    exit 1
  fi
  exit 0
fi

: "${DATABASE_URL:?set DATABASE_URL}" "${BLOB_DIR:?set BLOB_DIR}"
at=${BACKUP_AT:-03:17}
case $at in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *)
    echo "BACKUP_AT must be a UTC time like 03:17" >&2
    exit 2
    ;;
esac

backup() {
  # A killed run can leave its partial copy behind. Only this loop backs up
  # into the directory, one run at a time, so any partial copy now is stale.
  find "$dir" -mindepth 1 -maxdepth 1 -name '.wikistow-*.partial' -exec rm -rf {} +
  started=$(date -u +%s)
  if sh "$here/backup.sh" "$dir"; then
    # Whole or not at all: a file cut short would read as no backup.
    echo "$started" > "$dir/.last-success.new" && mv "$dir/.last-success.new" "$dir/.last-success"
    # Prune only after a success, so failing backups never remove the last good ones.
    find "$dir" -mindepth 1 -maxdepth 1 -name 'wikistow-*' -mtime +13 -exec rm -rf {} +
  else
    echo "Backup failed at $(date -u +%Y-%m-%dT%H:%M:%SZ). Retrying in an hour." >&2
    return 1
  fi
}

hh=${at%:*}
mm=${at#*:}
mkdir -p "$dir"
while :; do
  now=$(date -u +%s)
  # The newest BACKUP_AT that isn't in the future.
  slot=$((now - now % day + ${hh#0} * 3600 + ${mm#0} * 60))
  [ "$slot" -gt "$now" ] && slot=$((slot - day))
  if [ "$(last_success)" -lt "$slot" ]; then
    # A failure retries hourly until one succeeds; the healthcheck notices after 26 hours.
    backup || sleep 3600
  else
    sleep $((slot + day - now))
  fi
done
