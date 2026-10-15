#!/bin/sh
# Restore a backup made by backup.sh, replacing the database's contents, the
# attachment files and the plugin library's files. Stop the server first.
# See docs/operations.md.
#
#   DATABASE_URL=postgres://... BLOB_DIR=/data/blobs \
#     restore.sh --server-stopped /backups/wikistow-<time>
set -eu

: "${DATABASE_URL:?set DATABASE_URL}" "${BLOB_DIR:?set BLOB_DIR}"
if [ $# -ne 2 ] || [ "$1" != --server-stopped ]; then
  echo "usage: $0 --server-stopped <backup directory>" >&2
  echo "Stop the WikiStow server first. A running one would write over the restore." >&2
  exit 2
fi
backup=$2
if [ ! -f "$backup/SHA256SUMS" ]; then
  echo "$backup is not a complete backup" >&2
  exit 1
fi
# A copy cut short or damaged in transit can still unpack without error.
if ! (cd "$backup" && sha256sum -c SHA256SUMS > /dev/null); then
  echo "$backup is damaged: its files don't match SHA256SUMS" >&2
  exit 1
fi

# Its owner is who the restored files go to, so it must be the server's.
if [ ! -d "$BLOB_DIR" ]; then
  echo "$BLOB_DIR does not exist. Create it, owned by the user the server runs as, then restore." >&2
  exit 1
fi

# Unpack the files beside the live ones first, so a bad archive changes nothing.
incoming="$BLOB_DIR/objects.restoring"
rm -rf "$incoming"
mkdir "$incoming"
work=$(mktemp -d)
# How far it got, for what to say if it stops: nothing live has changed yet,
# the database is being restored, or it is and the files aren't yet.
stage=
# On any exit: stop pg_restore if it runs, so its transaction rolls back, and
# remove the unpacked files and the pipes. The lock goes with the script, as
# its psql reads the end of its commands then.
cleanup() {
  status=$?
  # Ignored, not reset, so a second Ctrl-C can't cut the cleanup short.
  trap - EXIT
  trap '' INT TERM HUP
  if [ -n "${restoring-}" ]; then
    kill "$restoring" 2>/dev/null || :
    wait "$restoring" 2>/dev/null || :
  fi
  rm -rf "$incoming" "$work"
  case $stage in
    database)
      echo "Stopped during the database restore. Keep the server stopped and run the restore again." >&2 ;;
    files)
      echo "The database is restored, but the files aren't. Keep the server stopped and run the restore again." >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT
# A shell killed by a signal skips its EXIT trap, so exit instead, through it.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
tar -C "$incoming" -xf "$backup/blobs.tar"
if [ ! -d "$incoming/objects" ] && [ ! -d "$incoming/plugins" ]; then
  echo "blobs.tar holds no objects/ or plugins/" >&2
  exit 1
fi
# A backup from before the plugin library, or of an installation with no
# attachments yet, lacks one of them: restored, it is empty.
mkdir -p "$incoming/objects" "$incoming/plugins"

# The flag is only the operator's word. A running server could write over the
# restore, or serve files and cached state from before it. Every WikiStow
# process, migrations included, holds this advisory lock shared for as long as
# it runs, on a connection it never lets close. Taken exclusively here, it
# fails while one runs, and they fail to start until the script ends. It is
# DATABASE_LOCK_KEY in packages/server/src/db/client.ts; keep the two the same.
lock_key=8604526663720791927
# The lock lasts as long as the session that took it, and pg_restore opens its
# own, so a psql in the background holds it. It reads commands from one pipe,
# open on fd 3, and answers on the other, on fd 4, through echo, as psql may
# buffer its own output. It ends once every copy of fd 3 is closed. The
# commands below inherit it on purpose: if the script is killed outright,
# past its traps, the lock lasts until pg_restore, or whatever else it was
# running, ends too.
mkfifo "$work/commands" "$work/answers"
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --set=key="$lock_key" \
  --dbname="$DATABASE_URL" < "$work/commands" > "$work/answers" &
holder=$!
exec 3> "$work/commands" 4< "$work/answers"
# Send psql the SQL on stdin, and read its answer. If psql is gone, writing
# kills only the subshell, and the answer is empty.
ask() {
  (cat >&3) 2>/dev/null || :
  read -r answer detail <&4 || answer=
}
# Its session must outlive an idle_session_timeout set for the database or
# role. Clients that take no lock, such as psql or a server older than the
# lock, are caught only if connected now, so count them too, leaving out this
# session. Sessions of a role this one can't inspect show no backend_type;
# those with a user count, which leaves out autovacuum.
ask <<'SQL'
set idle_session_timeout = 0;
select pg_try_advisory_lock(:key) as locked \gset
\if :locked
  select count(*) as others from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
      and (backend_type = 'client backend' or (backend_type is null and usesysid is not null))
    \gset
  \setenv others :others
  \! echo "locked $others"
\else
  \! echo held
\endif
SQL
case $answer in
  locked) ;;
  held)
    echo "The WikiStow server, its migrations or another restore is using the database. Stop the server, then restore." >&2
    exit 1 ;;
  *)
    echo "Could not lock the database; psql says why above." >&2
    exit 1 ;;
esac
# Compared as text, so anything but a plain 0 refuses.
if [ "$detail" != 0 ]; then
  echo "$detail other connection(s) to the database are open. Stop the WikiStow server, and anything else using the database, then restore." >&2
  exit 1
fi

# In one transaction, so a failed restore leaves the database as it was. In
# the background, and waited for, so a signal reaches the trap now and not
# once pg_restore is done.
stage=database
pg_restore --clean --if-exists --no-owner --no-acl --single-transaction \
  --dbname="$DATABASE_URL" "$backup/database.dump" 4<&- &
restoring=$!
# A signal runs its trap here. pg_restore's own failure, as on a dump from a
# newer pg_dump or a missing privilege, rolled back its transaction instead,
# so nothing has changed, and running it again fails the same way.
failed=0
wait "$restoring" || failed=$?
restoring=
if [ "$failed" -ne 0 ]; then
  stage=
  echo "pg_restore failed, so the database and the files are as they were. Fix what it says above before restoring again." >&2
  exit "$failed"
fi
stage=files

# If the lock's session ended meanwhile, as when Postgres restarted or someone
# ended it, a server may have started on the restored database. Swapping the
# files under it could lose what it wrote, so stop here.
ask <<'SQL'
select exists (select from pg_locks
  where locktype = 'advisory' and pid = pg_backend_pid() and mode = 'ExclusiveLock' and granted
    and (classid::bigint << 32 | objid::bigint) = :key and objsubid = 1) as held \gset
\if :held
  \! echo held
\else
  \! echo lost
\endif
SQL
if [ "$answer" != held ]; then
  echo "The database is restored, but the files aren't: the restore lost its lock on the database, so a server may have started on it. Stop any WikiStow server, then run the restore again." >&2
  stage=
  exit 1
fi

# Record the restore, which the server tells clients (GET /api/installation),
# so they take what it serves now as their new starting point rather than
# as a rollback. With the backup's time, from the name backup.sh gave its
# directory, if it has it. The dump brought back the settings row as it was,
# without these columns if older than them, so they're added as needed. See
# packages/server/src/db/schema/settings.ts.
taken=$(basename "$backup" | sed -n 's/^wikistow-\([0-9]\{8\}\)T\([0-9]\{6\}\)Z$/\1T\2Z/p')
ask <<SQL
\set taken '$taken'
set client_min_messages = warning;
alter table settings add column if not exists restored_at timestamptz,
  add column if not exists backup_taken_at timestamptz;
update settings set restored_at = now(), backup_taken_at = nullif(:'taken', '')::timestamptz;
\! echo recorded
SQL
if [ "$answer" != recorded ]; then
  echo "Could not record the restore; psql says why above." >&2
  exit 1
fi

for dir in objects plugins; do
  rm -rf "$BLOB_DIR/$dir"
  mv "$incoming/$dir" "$BLOB_DIR/$dir"
done
rmdir "$incoming"
# Run as root, as in a one-off container: give the files to BLOB_DIR's owner.
if [ "$(id -u)" -eq 0 ]; then
  chown -R "$(stat -c %u:%g "$BLOB_DIR/.")" "$BLOB_DIR/objects" "$BLOB_DIR/plugins"
fi
stage=
# Unlocked, and waited for, so a server started the moment this ends can lock.
ask <<'SQL'
select pg_advisory_unlock(:key) as unlocked \gset
\! echo unlocked
SQL
exec 3>&-
wait "$holder" || :
echo "Restored $backup"
