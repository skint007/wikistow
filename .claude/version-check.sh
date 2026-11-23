#!/bin/sh
# Lets a version pull request merge without waiting for its CI. The merge
# script runs this when a pull request changes only the version and
# CHANGELOG.md, on a main whose CI passed. It runs the CI check job's version
# and changelog steps. vp check skips Markdown (vite.config.ts), and the What's
# new page parses CHANGELOG.md with the code changelog.ts checks it with.
# Node only, no install needed.
set -e
node scripts/version.ts
node scripts/changelog.ts
