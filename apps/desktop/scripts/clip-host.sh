#!/bin/sh
# Build the web clipper's native messaging host, wikistow-clip-host
# (clip-host/, docs/adr/0017-web-clipper.md), for every system a desktop
# package ships on, from any one of them: Go needs no C toolchain or SDK
# for these. Run from apps/desktop with Go on PATH:
#
#   scripts/clip-host.sh
#
# Each lands in out/clip-host/<GOOS>-<GOARCH>/, where the packages take it
# from. The same source and Go give the same bytes: no paths, build IDs or
# symbol tables go in.
set -eu
out=$(mkdir -p out/clip-host && cd out/clip-host && pwd)
cd clip-host
for target in linux/amd64 windows/amd64 windows/arm64 darwin/arm64 darwin/amd64; do
  goos=${target%/*}
  goarch=${target#*/}
  name=wikistow-clip-host
  [ "$goos" = windows ] && name=$name.exe
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -buildvcs=false \
    -ldflags='-s -w -buildid=' -o "$out/$goos-$goarch/$name" .
done
ls -l "$out"/*/
