#!/bin/sh
# Build the signed apt and dnf repositories that hold the desktop app's
# newest stable .deb and .rpm (docs/releasing.md#the-apt-and-dnf-repositories),
# as the site GitHub Pages serves. Run it where apt-ftparchive, createrepo_c,
# rpmsign and gpg are, with the signing key in gpg's keyring:
#
#   SIGNING_KEY=<fingerprint> scripts/package-repos.sh <packages> <site> <url>
#
# <packages> holds the release's one .deb and one .rpm. <site> must not exist
# yet. <url> is where the site is served, as https://skint007.github.io/wikistow.
# The site holds only this release: apt and dnf need no other to upgrade.
set -eu
packages=$(cd "$1" && pwd)
site=$2
url=${3%/}
: "${SIGNING_KEY:?set it to the fingerprint of the signing key}"

# The one file of a kind in <packages>.
one() {
  set -- "$packages"/*."$1"
  if [ $# -ne 1 ] || [ ! -f "$1" ]; then echo "$packages must hold one .${1##*.}" >&2; exit 1; fi
  echo "$1"
}
deb=$(one deb)
rpm=$(one rpm)

mkdir "$site"
site=$(cd "$site" && pwd)
gpg --armor --export "$SIGNING_KEY" > "$site/wikistow.asc"
# SHA-1 signatures are refused by apt's sqv and by rpm-sequoia.
sign() { gpg --batch --yes --local-user "$SIGNING_KEY" --digest-algo SHA512 "$@"; }

# apt: one suite, stable, with one component, main. Only the Release file is
# signed (InRelease inline, Release.gpg beside it); it names the Packages
# index's checksum, which names each .deb's.
version=$(dpkg-deb -f "$deb" Version)
mkdir -p "$site/apt/pool/main" "$site/apt/dists/stable/main/binary-amd64"
cp "$deb" "$site/apt/pool/main/wikistow-desktop_${version}_amd64.deb"
cd "$site/apt"
apt-ftparchive packages pool > dists/stable/main/binary-amd64/Packages
gzip -9nk dists/stable/main/binary-amd64/Packages
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=WikiStow -o APT::FTPArchive::Release::Label=WikiStow \
  -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 -o APT::FTPArchive::Release::Components=main \
  -o APT::FTPArchive::Release::Description='WikiStow desktop app' \
  release dists/stable > "$site/Release"
mv "$site/Release" dists/stable/Release
sign --clearsign -o dists/stable/InRelease dists/stable/Release
sign --armor --detach-sign -o dists/stable/Release.gpg dists/stable/Release

# dnf: the .rpm signed itself, so `gpgcheck` checks it as installed, and the
# metadata signed too, for `repo_gpgcheck`.
mkdir "$site/rpm"
cp "$rpm" "$site/rpm/$(rpm -qp --qf '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}.rpm' "$rpm")"
cd "$site/rpm"
rpmsign --define "_gpg_name $SIGNING_KEY" --define '_gpg_digest_algo sha512' --addsign ./*.rpm
createrepo_c --quiet .
sign --armor --detach-sign -o repodata/repomd.xml.asc repodata/repomd.xml

# What people add, from docs/desktop.md. The app tells a repository install
# by these files' names (apps/desktop/src/updates.ts).
cat > "$site/wikistow.sources" <<EOF
Types: deb
URIs: $url/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/wikistow.asc
EOF
# The app checks for releases every 6 hours, so dnf looks as often.
cat > "$site/wikistow.repo" <<EOF
[wikistow]
name=WikiStow
baseurl=$url/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=$url/wikistow.asc
metadata_expire=6h
EOF
cat > "$site/index.html" <<EOF
<!doctype html>
<meta charset="utf-8">
<title>WikiStow packages</title>
<p>The WikiStow desktop app's apt and dnf repositories.
<a href="https://github.com/skint007/wikistow/blob/main/docs/desktop.md#debian-ubuntu-and-fedora">How to add them</a>.
EOF
