# WikiStow agent instructions

## Tracking work

The [project board](docs/project-board.md) holds where work stands, including what waits on Scott. Change it with `node scripts/board.ts`; the doc has the commands.

- Memory never records whether an issue or PR is open, merged or waiting. Run `board list` to see. Memory keeps gotchas and reasons.
- File issues with `board add` and their `area:` labels. Run `board start` when you start one, and put `Closes #N` in its PR.
- A question for Scott that outlives your turn gets a card: `board ask`, or `board wait` on an open issue, with a one-sentence Next step. Record his answer in the ADR's Decided section or on the issue, then clear it.
- Only Scott drops work. Ask first, then `board drop --why`, quoting him. Plain duplicates you may drop yourself.
- An unbuilt ADR step names its issue; the PR that builds it marks the step "(built, PR #N)".
- After pushing a beta tag, `board ask "Is <version> good?" --waiting try`. The promotion PR closes it.
- Run `board check` after each batch and before cutting a release.

## Releasing

Follow `docs/releasing.md`. These rules cover where a release can stall.

- A new version goes out as a beta first (`<version>-beta.1`), unless the user asks for a stable release. Promote it only when the user says the beta is good ([beta and stable](docs/releasing.md#beta-and-stable)).

- After the version PR merges, do not end the turn until the release tag is pushed.
- Wait for CI on the merge commit in the foreground. Repeat `gh run watch <run-id> --exit-status` until the run finishes. A foreground call stops after 10 minutes, so call it again.
- Never start a background watcher (`run_in_background`, or a trailing `&`) for this wait and then end the turn. The background command is killed when the turn ends, and nothing wakes you.
- Do not write "I will tag once CI passes" and stop. If you cannot wait, say that you are stopping before the tag, and ask the user to continue.
- Before you tag, check that CI on the merge commit passed, that `main` has not moved, and that the UTC day still matches the changelog entry.
