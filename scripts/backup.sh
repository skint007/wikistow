#!/bin/sh
# Back up a WikiStow installation: the database, then the encrypted
# attachment files. Safe while the server runs. See docs/operations.md.
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
# could miss a file the dump lists.
pg_dump --format=custom --file="$partial/database.dump" --dbname="$DATABASE_URL"

# Only objects/: staging/ holds unfinished uploads, which no dump lists. A
# new installation has no objects/ until its first attachment.
from=$BLOB_DIR
[ -d "$from/objects" ] || { from=$partial/empty; mkdir -p "$from/objects"; }
# tar fails when files come and go as it reads, which a running server
# does, so it gets a few tries.
for try in 1 2 3; do
  tar -C "$from" -cf "$partial/blobs.tar" objects && break
  [ "$try" -lt 3 ] || exit 1
done
rm -rf "$partial/empty"

# Every file the dump lists must be in blobs.tar. A wrong BLOB_DIR misses
# them all, and deleting a page removes its files at once, so one deleted
# while tar ran would come back without them. `hash` is the table's first
# column; were it not, nothing would match and the backup would fail.
pg_restore --data-only --table=blobs --file="$partial/blobs.sql" "$partial/database.dump"
awk -F '\t' '/^COPY /{on=1; next} /^\\\.$/{on=0} on{print $1}' "$partial/blobs.sql" |
  sort > "$partial/listed"
tar -tf "$partial/blobs.tar" > "$partial/entries"
sed -n 's|^objects/[^/]*/\([^/][^/]*\)$|\1|p' "$partial/entries" | sort > "$partial/archived"
missing=$(comm -23 "$partial/listed" "$partial/archived")
rm "$partial/blobs.sql" "$partial/entries" "$partial/listed" "$partial/archived"
if [ -n "$missing" ]; then
  echo "blobs.tar lacks $(echo "$missing" | wc -l) file(s) the database lists:" >&2
  echo "$missing" | head -n 20 >&2
  echo "Check BLOB_DIR, then run the backup again. See docs/operations.md if they stay missing." >&2
  exit 1
fi

(cd "$partial" && sha256sum database.dump blobs.tar > SHA256SUMS)
mv "$partial" "$out/$name"
echo "$out/$name"
