#!/bin/sh
# Build the CLI as one binary per system from dist/wikistow.mjs, the bundle
# CI built and tested, and put the install scripts beside them. Bun compiles
# each one with its own runtime, downloaded for that system. Run from
# apps/cli after `vp pack`, with Bun on PATH (release.yml pins its version):
#
#   scripts/binaries.sh <version> <output folder>
#
# Then it checks the Linux x64 binary runs outside the workspace and says it
# is <version>.
set -eu
version=$1
out=$(mkdir -p "$2" && cd "$2" && pwd)

for target in linux-x64 linux-arm64 darwin-arm64 darwin-x64 windows-x64; do
  file="wikistow-$target"
  case $target in windows-*) file="$file.exe" ;; esac
  # A .env or bunfig.toml in the folder it runs in must not change it.
  bun build dist/wikistow.mjs --compile --target="bun-$target" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile "$out/$file"
done
cp install/install.sh install/install.ps1 "$out/"

[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || exit 0
check=$(mktemp -d)
trap 'rm -rf "$check"' EXIT
mkdir "$check/home"
cp "$out/wikistow-linux-x64" "$check/wikistow"
cd "$check"
said=$(./wikistow --version)
[ "$said" = "wikistow $version" ] || { echo "The binary says $said, not wikistow $version" >&2; exit 1; }
./wikistow --help >/dev/null
# Unenrolled, it says so with its own exit status.
code=0
HOME="$check/home" ./wikistow spaces list --json >/dev/null 2>&1 || code=$?
[ "$code" -eq 5 ] || { echo "Unenrolled, the binary exited $code, not 5" >&2; exit 1; }
