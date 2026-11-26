# Project board

Work on WikiStow is tracked on the public [WikiStow board](https://github.com/users/skint007/projects/2), project 2 of the `skint007` account. Its items are this repo's issues and pull requests. The board holds where each one stands, including what waits on Scott. Each issue says what to build, and holds Scott's decisions on it.

Change the board with `scripts/board.ts`, which looks up the board's IDs by name on every run:

```sh
node scripts/board.ts list [--waiting] [--area search]      # open cards, by Priority
node scripts/board.ts add "<title>" --body-file F --area search [--area …] [--low]
node scripts/board.ts start 123                             # In Progress
node scripts/board.ts ask "<title>" --body-file F --waiting decide --next "<one sentence>"
node scripts/board.ts wait 123 decide|try|do|outside --next "<one sentence>"
node scripts/board.ts wait 123 --clear
node scripts/board.ts drop 123 --why "<reason>" [--duplicate-of 120]
node scripts/board.ts set 123 Status=Done "Next step="      # any field but Priority; Field= clears it
node scripts/board.ts check                                 # problems exit 1; notes only warn
node scripts/board.ts setup                                 # creates the fields, label and views; changes nothing when they exist
```

It needs the token's `project` scope. If a command says the scope is missing, run `gh auth refresh -s project`; Scott approves it in a browser.

## Status

| Status | Meaning | Who moves it |
| --- | --- | --- |
| Todo | Filed, not started | Set when an item is added |
| In Progress | Someone is working on it | You: `board start` |
| In Review | A pull request is open for it | The board, when a PR that closes the issue is opened |
| Done | Closed as completed, or merged | The board, when the issue closes or the PR merges |
| Dropped | Closed because we chose not to build it | You: `board drop`, once Scott says so |

The board moves an issue only when its PR closes it (`Closes #N` in the body). For a PR that only refers to an issue, move the issue to In Review yourself. The board sometimes misses a move; `check` reports it.

Reopening a Done or Dropped issue puts it back in Todo.

## Waiting on Scott

**Waiting** says who acts next, when it isn't an agent. **Next step** says what to do, in one plain sentence that names where: "Open Settings → Browser clipping on the Mac and say whether the folder search is fast enough."

| Waiting | When |
| --- | --- |
| Scott: decide | A choice only Scott makes: scope, a spec question, what to drop |
| Scott: try it | Something to try: a beta, hand checks on a system CI doesn't cover |
| Scott: do it | Accounts, certificates, store listings, browser-only settings, his hardware |
| Outside | A store review, an upstream fix or a certificate authority |

A question that outlives your turn gets a card. File a new one with `board ask`, which labels it `question`, or mark an issue already open with `board wait`. When Scott answers, quote him with the date in a comment on the issue. Then clear Waiting, or close the question.

The **Waiting** view lists these cards. Choices you make without Scott go in the PR body under "Decided without you". They get no card. Never record one as Scott's decision.

After you push a beta tag, ask whether it is good: `board ask "Is 0.27.0-beta.1 good?" --waiting try --next "…"`, with what to try, taken from the highlights. A later beta updates the same question, and the version PR that promotes it closes it.

## Dropping

Only Scott drops a feature or an issue. If you think one isn't worth doing, ask first (`board wait 123 decide --next "Drop this? …"`). Once he says so, run `board drop 123 --why "…"`, quoting him with the date. It closes the issue as not planned, comments "Dropped: …", and sets Dropped. You may drop a plain duplicate yourself, with `--duplicate-of`.

Folding Lows into one checklist issue, as #600 does, isn't dropping. Take the folded issue off the board; the fold issue carries it.

## Areas and labels

An issue's area is its `area:` label. Give every issue you file one or more of them; list them with `gh label list --search "area:"`. If none fits, use `--no-area` and say so in your reply, rather than adding a label.

`question` marks an issue only Scott can settle. `low` marks a Low review finding that is a real bug and got an issue of its own. Other Lows go in the PR body. The Board view hides `low` and Dropped cards; the **Lows** view lists the Lows.

The board's Priority field (P0 now, P1 next, P2 later) is Scott's to set. Leave it as it is; `set` refuses it.

## Check

Run `node scripts/board.ts check` after each batch and before cutting a release. It exits 1 on a problem:

- an open issue that isn't on the board;
- a closed or merged item that isn't Done or Dropped, or an open one that is;
- an issue closed as not planned or as a duplicate that isn't Dropped;
- In Review with no open PR naming the issue, or In Progress with an open PR that closes it;
- a `question` with no Waiting, Waiting with no Next step, or Waiting on a closed card;
- a beta as the newest tag with no open question asking whether it is good.

Its notes only warn: an issue without an `area:` label, In Progress for over three days with no open PR, a draft item on the board, and a Dropped issue with no "Dropped:" comment giving the reason.

## Limits

- The board is public. Question bodies and Next steps are too: no server names, private hosts, account emails or tokens. A security finding goes to a private advisory, not a card.
- The board's workflows (auto-add, closed → Done, a linked PR → In Review, reopened → Todo) are set in the browser; the API can't read or change them. "Item closed" sets Done on any close, so `drop` waits for it before setting Dropped.
- Changing a select field's options sends the whole list. `setup` sends the existing options back with their IDs, so no card loses its value and the workflows keep their targets.
- The API can't group or sort a view. Group the Waiting view by Waiting in the browser.
