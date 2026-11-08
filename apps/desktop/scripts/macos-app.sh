#!/bin/sh
# Build WikiStow.app for one kind of Mac, `arm64` (Apple silicon) or `x64`
# (Intel), zipped: out/app.asar in Electron's own darwin build, named
# WikiStow, claiming `wikistow://` links, with the Mac icon
# (packaging/wikistow-desktop.icns: wikistow-desktop.svg on Apple's icon
# grid). Adding the asar breaks Electron's signature, and Apple silicon runs
# nothing unsigned, so the app is signed again ad hoc. Not with a Developer
# ID: Gatekeeper still asks the person to allow it (docs/desktop.md). Run on
# a Mac, from apps/desktop after scripts/asar.ts, with the workspace installed:
#
#   scripts/macos-app.sh <version> <arm64|x64> <output folder>
#
# It leaves WikiStow.app in the output folder too, for the launch check.
set -eu
version=$1
arch=$2
out=$(mkdir -p "$3" && cd "$3" && pwd)
[ "$(uname -s)" = Darwin ] || { echo "Build the Mac app on macOS" >&2; exit 1; }
case "$arch" in arm64 | x64) ;; *) echo "No Mac is $arch" >&2; exit 1 ;; esac

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# The Electron the desktop tests run, checked against the checksums its
# package ships with, which the lockfile pins.
electron=node_modules/electron
electron_version=$(node -p "require('./$electron/package.json').version")
zip="electron-v$electron_version-darwin-$arch.zip"
sum=$(node -p "require('./$electron/checksums.json')['$zip']")
curl -fsSL --retry 10 --retry-all-errors --retry-delay 30 -o "$stage/$zip" "https://github.com/electron/electron/releases/download/v$electron_version/$zip"
echo "$sum  $stage/$zip" | shasum -a 256 -c -

ditto -x -k "$stage/$zip" "$stage"
app="$stage/WikiStow.app"
mv "$stage/Electron.app" "$app"
mv "$app/Contents/MacOS/Electron" "$app/Contents/MacOS/WikiStow"
# Electron starts Resources/app.asar in place of its own default app.
rm "$app/Contents/Resources/default_app.asar" "$app/Contents/Resources/electron.icns"
cp out/app.asar "$app/Contents/Resources/app.asar"
cp packaging/wikistow-desktop.icns "$app/Contents/Resources/wikistow.icns"
# How it was installed, for the update notice (src/updates.ts).
echo mac > "$app/Contents/Resources/install-source"

plist="$app/Contents/Info.plist"
set_key() { plutil -replace "$1" "$2" "$3" "$plist"; }
set_key CFBundleExecutable -string WikiStow
set_key CFBundleName -string WikiStow
set_key CFBundleDisplayName -string WikiStow
set_key CFBundleIdentifier -string io.github.skint007.wikistow
set_key CFBundleIconFile -string wikistow.icns
set_key CFBundleShortVersionString -string "$version"
# Numbers only; a prerelease's `-rc.1` is in the short version.
set_key CFBundleVersion -string "${version%%-*}"
# The scheme the browser hands sign-ins back on; main hears them as `open-url`.
set_key CFBundleURLTypes -json '[{"CFBundleURLName":"WikiStow sign-in","CFBundleURLSchemes":["wikistow"]}]'
plutil -lint "$plist" >/dev/null

codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

rm -rf "$out/WikiStow.app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out/wikistow-desktop-$version-macos-$arch.zip"
mv "$app" "$out/WikiStow.app"
