# Project board

Work on WikiStow is tracked on the public [WikiStow board](https://github.com/users/skint007/projects/2), project 2 of the `skint007` account. Its items are this repo's issues and pull requests.

`gh project` commands need the token's `project` scope. If a command says the scope is missing, run `gh auth refresh -s project`; the person approves it in a browser.

## Status

| Status | Meaning | Who moves it |
| --- | --- | --- |
| Todo | Filed, not started | Set when an item is added |
| In Progress | Someone is working on it | You, when you start the issue |
| In Review | A pull request is open for it | The board, when a PR that closes the issue is opened |
| Done | Closed or merged | The board, when the issue closes or the PR merges |

The board moves an issue only when its PR closes it (`Closes #N` in the body). For a PR that only refers to an issue, move the issue to In Review yourself.

## Areas

An issue's area is its `area:` label. Give every issue you file one or more of them; list them with `gh label list --search "area:"`. If none fits, leave the area off and say so in your reply, rather than adding a label.

The board's Priority field (P0 now, P1 next, P2 later) is the person's to set. Leave it as it is.

## Moving an issue

Adding an issue that is already on the board returns its existing item, so the same two commands put an issue on the board and set its Status:

```sh
item=$(gh project item-add 2 --owner skint007 --url https://github.com/skint007/wikistow/issues/<number> --format json -q .id)
gh project item-edit --project-id PVT_kwHOAjUfS84Brq8S --id "$item" \
  --field-id PVTSSF_lAHOAjUfS84Brq8Szhp8kc0 --single-select-option-id <option>
```

Status options: Todo `f75ad846`, In Progress `47fc9ee4`, In Review `c8100da7`, Done `98236657`.
