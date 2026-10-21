# WikiStow agent instructions

## Releasing

Follow `docs/releasing.md`. These rules cover where a release can stall.

- After the version PR merges, do not end the turn until the release tag is pushed.
- Wait for CI on the merge commit in the foreground. Repeat `gh run watch <run-id> --exit-status` until the run finishes. A foreground call stops after 10 minutes, so call it again.
- Never start a background watcher (`run_in_background`, or a trailing `&`) for this wait and then end the turn. The background command is killed when the turn ends, and nothing wakes you.
- Do not write "I will tag once CI passes" and stop. If you cannot wait, say that you are stopping before the tag, and ask the user to continue.
- Before you tag, check that CI on the merge commit passed, that `main` has not moved, and that the UTC day still matches the changelog entry.
