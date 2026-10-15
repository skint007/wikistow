#!/bin/sh
# Build the .deb and .rpm: out/app.asar, run by the Electron the desktop
# tests run on, packaged by nfpm (packaging/nfpm.yaml). Run from apps/desktop
# after scripts/asar.ts, with nfpm on PATH:
#
#   scripts/linux-packages.sh <version> <output folder>
#
# SOURCE_DATE_EPOCH, if set, fixes the files' times.
set -eu
version=$1
out=$(mkdir -p "$2" && cd "$2" && pwd)
# The packages are x86_64, and Electron downloads for the machine it's on.
[ "$(uname -m)" = x86_64 ] || { echo "Build the packages on x86_64" >&2; exit 1; }

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# The electron package downloads its runtime, checked against the checksums
# it ships with. It skips that for a copy already extracted, which pnpm's
# cache may have restored, so download into a fresh copy of the package.
electron=$(realpath node_modules/electron)
mkdir "$stage/electron"
cp "$electron/package.json" "$electron/install.js" "$electron/checksums.json" "$stage/electron/"
# Its own dependencies, found before any node_modules above the stage.
ln -s "$(dirname "$electron")" "$stage/node_modules"
node "$stage/electron/install.js"
mv "$stage/electron/dist" "$stage/lib"
rm -r "$stage/electron" "$stage/node_modules"
mv "$stage/lib/electron" "$stage/lib/wikistow-desktop"
# Electron starts resources/app.asar in place of its own default app.
rm "$stage/lib/resources/default_app.asar"
cp out/app.asar "$stage/lib/resources/app.asar"
# nfpm gives the sandbox helper its setuid mode separately.
mv "$stage/lib/chrome-sandbox" "$stage/chrome-sandbox"
cp packaging/wikistow-desktop packaging/wikistow-desktop.desktop packaging/wikistow-desktop.svg \
  packaging/wikistow-desktop.png ../../LICENSE packaging/nfpm.yaml "$stage/"
echo deb > "$stage/install-source.deb"
echo rpm > "$stage/install-source.rpm"
# nfpm takes the tree's modes and times from its files, so make them the
# same whatever the umask and download time.
chmod -R u+rwX,go+rX,go-w "$stage"
if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +; fi

# Named like the release archive. nfpm's own names put a `~` in a
# prerelease's, which GitHub would change on upload.
cd "$stage"
export VERSION="$version"
nfpm package --config nfpm.yaml --packager deb --target "$out/wikistow-desktop-$version-amd64.deb"
nfpm package --config nfpm.yaml --packager rpm --target "$out/wikistow-desktop-$version-x86_64.rpm"
