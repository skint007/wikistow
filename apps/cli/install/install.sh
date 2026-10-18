#!/bin/sh
# Install or update the WikiStow CLI, `wikistow`, on Linux or macOS:
#
#   curl -fsSL https://github.com/skint007/wikistow/releases/latest/download/install.sh | sh
#
# It downloads this system's binary from the latest release, checks it against
# the release's SHA256SUMS, and puts it in ~/.local/bin, adding that to PATH in
# the shell's startup file if it's missing. Run it again to update. To install
# another release, set WIKISTOW_RELEASE_URL to its downloads, such as
# https://github.com/skint007/wikistow/releases/download/v0.13.0.
set -eu

release=${WIKISTOW_RELEASE_URL:-https://github.com/skint007/wikistow/releases/latest/download}
dir="$HOME/.local/bin"

fail() {
  echo "wikistow install: $*" >&2
  exit 1
}

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "this script is for Linux and macOS. On Windows, use install.ps1." ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 loader=/lib64/ld-linux-x86-64.so.2 ;;
  aarch64 | arm64) arch=arm64 loader=/lib/ld-linux-aarch64.so.1 ;;
  *) fail "there is no binary for $(uname -m)." ;;
esac
# The Linux binaries need 64-bit glibc. Alpine and other musl systems can run the
# release's wikistow.mjs on Node.js instead.
if [ "$os" = linux ] && [ ! -e "$loader" ]; then
  fail "the Linux binaries need 64-bit glibc, which this system doesn't have. Musl systems such as Alpine, and 32-bit systems, aren't supported."
fi
name="wikistow-$os-$arch"

if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
else
  fail "it needs curl or wget."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1"; }
else
  sha256() { shasum -a 256 "$1"; }
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM

echo "Downloading $name from $release"
download "$release/SHA256SUMS" "$tmp/SHA256SUMS" || fail "couldn't download $release/SHA256SUMS."
download "$release/$name" "$tmp/$name" || fail "couldn't download $release/$name."
want=$(awk -v f="$name" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "SHA256SUMS has no line for $name."
got=$(sha256 "$tmp/$name" | awk '{ print $1 }')
[ "$got" = "$want" ] || fail "$name doesn't match its checksum in SHA256SUMS."

chmod 755 "$tmp/$name"
mkdir -p "$dir"
# Renamed into place from the same folder, so a copy that's running is
# replaced all at once.
cp "$tmp/$name" "$dir/.wikistow.new"
mv -f "$dir/.wikistow.new" "$dir/wikistow"
version=$("$dir/wikistow" --version) || fail "$dir/wikistow didn't run."
echo "Installed $version in $dir"

case ":$PATH:" in
  *":$dir:"*)
    found=$(command -v wikistow)
    if [ "$found" != "$dir/wikistow" ]; then
      echo "Note: $found comes before it on PATH, so typing wikistow runs that one."
    fi
    ;;
  *)
    line='export PATH="$HOME/.local/bin:$PATH"'
    # Containers often leave SHELL unset; then it's ~/.profile.
    shell=${SHELL:-}
    case ${shell##*/} in
      zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
      bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      fish)
        rc="$HOME/.config/fish/config.fish"
        line='fish_add_path "$HOME/.local/bin"'
        ;;
      *) rc="$HOME/.profile" ;;
    esac
    if grep -qsF "$line" "$rc"; then
      echo "$rc adds $dir to PATH. Open a new terminal to use wikistow."
    else
      mkdir -p "$(dirname "$rc")"
      printf '\n# The WikiStow CLI\n%s\n' "$line" >>"$rc"
      echo "Added $dir to PATH in $rc. Open a new terminal to use wikistow."
    fi
    ;;
esac
