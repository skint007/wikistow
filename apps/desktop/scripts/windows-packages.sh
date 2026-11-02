#!/bin/sh
# Build the Windows installers, x64 and arm64: out/app.asar in Electron's
# Windows build of the version the desktop tests run, as WikiStow.exe,
# installed by an NSIS installer (packaging/windows.nsi). The app has no
# native modules, so this runs on Linux. Run from apps/desktop after
# scripts/asar.ts, with makensis on PATH:
#
#   scripts/windows-packages.sh <version> <output folder> [x64|arm64]
#
# Without an architecture it builds both. Each takes a few minutes, as LZMA
# compresses the whole app, so CI builds them side by side.
set -eu
version=$1
out=$(mkdir -p "$2" && cd "$2" && pwd)
arches=${3:-x64 arm64}
# Windows takes four numbers; a prerelease keeps its release's.
file_version="$(printf '%s' "$version" | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/').0"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

electron=$(realpath node_modules/electron)
for arch in $arches; do
  # The electron package downloads the build, checked against the checksums
  # it ships with, into a fresh copy of itself, as linux-packages.sh does.
  mkdir "$stage/electron"
  cp "$electron/package.json" "$electron/install.js" "$electron/checksums.json" "$stage/electron/"
  ln -s "$(dirname "$electron")" "$stage/node_modules"
  npm_config_platform=win32 npm_config_arch=$arch node "$stage/electron/install.js"
  app="$stage/$arch"
  mv "$stage/electron/dist" "$app"
  rm -r "$stage/electron" "$stage/node_modules"

  mv "$app/electron.exe" "$app/WikiStow.exe"
  # Electron starts resources/app.asar in place of its own default app.
  rm "$app/resources/default_app.asar"
  cp out/app.asar "$app/resources/app.asar"
  # How it was installed, for the update notice (src/updates.ts).
  printf 'windows\n' > "$app/resources/install-source"
  cp ../../LICENSE "$app/LICENSE.WikiStow.txt"
  node scripts/windows-exe.ts "$app/WikiStow.exe" "$version"

  makensis -V2 -DVERSION="$version" -DFILE_VERSION="$file_version" -DARCH="$arch" \
    -DAPP="$app" -DOUT="$out/wikistow-desktop-$version-$arch-setup.exe" packaging/windows.nsi
done
