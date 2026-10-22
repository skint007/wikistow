#!/bin/sh
# Back up a WikiStow installation: the database, then the encrypted
# attachment files and the plugin library's files. Safe while the server
# runs. See docs/operations.md.
#
#   DATABASE_URL=postgres://... BLOB_DIR=/data/blobs backup.sh /backups
#
# Writes /backups/wikistow-<UTC time>/ holding database.dump, blobs.tar and
# their SHA256SUMS, readable only by the user who ran it, and prints its path.
set -eu

: "${DATABASE_URL:?set DATABASE_URL}" "${BLOB_DIR:?set BLOB_DIR}"
if [ $# -ne 1 ]; then
  echo "usage: $0 <directory to write the backup in>" >&2
  exit 2
fi
out=$1

umask 077
name="wikistow-$(date -u +%Y%m%dT%H%M%SZ)"
partial="$out/.$name.partial"
mkdir -p "$out"
if [ -e "$out/$name" ]; then
  echo "$out/$name already exists" >&2
  exit 1
fi
mkdir "$partial"
# A failed backup leaves nothing behind. After the final mv, this removes nothing.
trap 'rm -rf "$partial"' EXIT

# The database first. A file saved after the dump is only an extra file in
# blobs.tar, which the server deletes after a restore. The other order
# could miss a file the dump lists. Public links' rows stay out: they hold
# readable copies of pages (ADR 0005), so a restore has every link off.
pg_dump --format=custom --file="$partial/database.dump" --dbname="$DATABASE_URL" \
  --exclude-table-data=public_links --exclude-table-data=public_copies \
  --exclude-table-data=public_files --exclude-table-data=public_targets

# Only objects/ (attachments) and plugins/ (the plugin library's versions):
# staging/ and plugin-staging/ hold unfinished uploads, which no dump lists.
# A new installation has neither until its first attachment or plugin.
from=$BLOB_DIR
dirs=
for dir in objects plugins; do
  [ -d "$from/$dir" ] && dirs="$dirs $dir"
done
[ -n "$dirs" ] || { from=$partial/empty; dirs=objects; mkdir -p "$from/objects"; }
# tar fails when files come and go as it reads, which a running server
# does, so it gets a few tries.
for try in 1 2 3; do
  tar -C "$from" -cf "$partial/blobs.tar" $dirs && break
  [ "$try" -lt 3 ] || exit 1
done
rm -rf "$partial/empty"

# Every file the dump lists must be in blobs.tar: each attachment blob, and
# each plugin version's manifest. A wrong BLOB_DIR misses them all, and
# deleting a page or a plugin removes its files at once, so one deleted
# while tar ran would come back without them. `hash` is each table's first
# column; were it not, nothing would match and the backup would fail.
pg_restore --data-only --table=blobs --table=plugin_versions --file="$partial/listed.sql" \
  "$partial/database.dump"
awk -F '\t' '
  /^COPY ([^ ]*\.)?blobs /{on="objects"; next}
  /^COPY ([^ ]*\.)?plugin_versions /{on="plugins"; next}
  /^\\\.$/{on=""}
  on{print on "/" $1}' "$partial/listed.sql" | sort > "$partial/listed"
tar -tf "$partial/blobs.tar" > "$partial/entries"
sed -n -e 's|^\(objects\)/[^/]*/\([^/][^/]*\)$|\1/\2|p' \
  -e 's|^\(plugins\)/\([^/][^/]*\)/wikistow-plugin\.json$|\1/\2|p' \
  "$partial/entries" | sort > "$partial/archived"
missing=$(comm -23 "$partial/listed" "$partial/archived")
rm "$partial/listed.sql" "$partial/entries" "$partial/listed" "$partial/archived"
if [ -n "$missing" ]; then
  echo "blobs.tar lacks $(echo "$missing" | wc -l) file(s) the database lists:" >&2
  echo "$missing" | head -n 20 >&2
  echo "Check BLOB_DIR, then run the backup again. See docs/operations.md if they stay missing." >&2
  exit 1
fi

(cd "$partial" && sha256sum database.dump blobs.tar > SHA256SUMS)
mv "$partial" "$out/$name"
echo "$out/$name"
