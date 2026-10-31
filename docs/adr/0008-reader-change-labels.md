---
status: accepted
---

# Labels for versions made by changes while reading

Since #212, an editor who can publish can tick a page's tasks, and change values a plugin block sets, while reading the page. Each burst of those changes publishes one new version. A shopping list ticked every day soon has a long history of versions that differ by a few ticks, and history shows each one the same way as a real edit: a number, who published it and when. #213 asks for those versions to say what changed, such as "Ticked 3, unticked 1" or "Changed servings", so real edits stay easy to find.

In short:
- The publication that carries changes made while reading writes a payload extension, `wikistow.change`, with what changed: how many tasks were ticked and unticked, and which properties changed.
- The extension names the version it is in. A version shows it only when it names that version, so a copy carried into a later version never shows.
- Drafts are saved without it, and every other publish leaves it out.
- History opens the versions it lists to read it, 20 at a time, and folds a run of them by the same person into one row.

## What the code supports today

- **Changes made while reading are saved, then published** (`flushChanges` in `packages/ui/src/page/reading-changes-model.ts`). A flush opens the current draft, makes each change in its Markdown (`setTask` in `packages/client/src/markdown/tasks.ts`, `setPageProperty` in `properties.ts`), saves the result as a new draft, and publishes that draft if the draft had no changes of its own. Otherwise, or if the page has a public link by then, the changes stay in the draft.
- **Publishing copies the draft's payload.** It works the link table out again and reseals attachments, and copies every other extension unchanged (protocol section 5.5). The published record's signed `basedOn` is the draft it was made from (section 5.1).
- **A draft can be published more than once.** The server checks only the published head, so Publish on a draft with no changes, or publishing again after an unpublish, makes another version from the same draft, with the same `basedOn`.
- **Unknown extensions are carried forward.** A client copies namespaces it doesn't know unchanged into the next version (section 5.5). So does `revisePayload` for every namespace the caller doesn't name.
- **History lists signed records only** (`loadHistory` in `packages/client/src/operations/pages.ts`, `HistorySheet` in `packages/ui/src/page/history-sheet.tsx`). It shows every published version at once, and opens none of them. Readers see only the versions since the page was last unpublished (`readerHistoryFrom`, section 11), and hold the keys to open them.
- **Opened revisions are cached** in memory (`RevisionCache`, 32 MB), so a version opened once isn't fetched or decrypted again while the vault is unlocked.

## Decisions

### 1. A payload extension, written by the publication

Scott chose this over working the label out by comparing each version with the one before it (see **Considered options**).

The flush saves its draft as before, and its publish adds `wikistow.change` to the published payload:

```
{ format: 1, revision: RevisionId, ticked: integer ≥ 0, unticked: integer ≥ 0, properties: string[] }
```

`ticked` and `unticked` count the task items whose box changed, and `properties` names the keys whose value changed, as written in the frontmatter. They come from comparing the draft's Markdown before and after the changes, not from counting the changes queued. So a box ticked and then unticked in one burst counts as nothing, and a change that no longer applied isn't counted.

A flush publishes only when the draft had no changes of its own, so the version is the publication before it plus the changes made while reading, which is what the label says. If the flush leaves the changes in the draft, because the page got a public link or someone published meanwhile, nothing is labelled, even if someone publishes that draft later. That is rare, and the version then looks like any other.

### 2. It names the version it is in

`revision` is the revision ID of the publication itself. A version shows the label only when `revision` is its own ID. The app makes the ID when it seals the publication, so the publish puts the ID in the payload as it seals it (`commitFor` takes the ID).

This is the trap the issue warns about. An app from before this change doesn't know the namespace, so it copies the extension into its next version. Every copy names a version it isn't, so none shows a label. The same holds for every other way a payload gets copied: restoring a version as the draft, detaching a publication, copying a page (protocol section 10), and publishing into another space (section 13).

Naming the draft the changes were saved in, and checking the publication's `basedOn`, would have kept the label with the draft. But publishing that draft again makes a second version with the same `basedOn`, which would show the label too, though it changed nothing. Readers couldn't tell the two apart, as after an unpublish they don't see the first.

### 3. Drafts and other publishes leave it out

`saveDraft`, `publishPage` without what changed, and `restorePublished` all leave `wikistow.change` out. Only a flush's publish passes what changed. So a draft this app saves never holds it, and the next ordinary save drops a copy an older app or a detach brought in. Thanks to decision 2, a copy that survives anyway does no harm. Leaving it out keeps payloads tidy.

### 4. History reads the label

History opens the published versions it lists to read their labels. It lists the newest 20, with **Show older versions** to list 20 more, and opens only the versions listed. Each version is opened once: through the revision cache, and its label then stays in the query cache while history is open. A version that doesn't open, is in a newer format, or has no valid extension shows no label.

Readers open the versions in their own history, from `readerHistoryFrom`, whose keys they hold. Each label is checked against that version's own record, never the version before it, so the oldest version a reader sees is labelled like any other.

A label reads "Ticked 3, unticked 1", "Changed servings", or both ("Ticked 1, changed servings"). More than three properties are named as "servings, rating, time and 2 more". A version whose extension counts nothing reads "Changed while reading".

### 5. Runs fold into one row

Versions in a row that each have a label, published by the same person or agent, show as one row: the newest of them, with a button to show the others, such as "2 earlier changes while reading". The version readers' history starts at is in no run, so the line that marks it stays in place. A run shows open when the version being viewed is one it would hide. The folded row keeps its own label, View and Restore, so nothing changes for the newest version, and nothing is added up across versions.

### 6. What it tells anyone

The extension is inside the encrypted payload, so the server learns nothing new. Anyone who can open the version could compare it with the version before it and learn the same. The counts come from a draft that equalled the publication before, so they tell readers nothing about any draft.

## Considered options

- **Compare each version with the one before it when history opens.** No format change, and it works for versions published before this change. But history would open two versions for every row, and compare tasks and properties for each pair. Readers' oldest version has no version before it they can open, so it would get no label. A plain edit that also ticked a box would read as a tick. Rejected by Scott in favour of the extension.
- **Name the draft the changes were saved in**, written by the draft save, and show the label on a publication whose `basedOn` is that draft. Publishing the same draft again copies the label onto a version that changed nothing (decision 2). Rejected for naming the publication itself.
- **Name the publication the changes were made on**, and show the label when that is the version just before in history. This fails when the changes stay in the draft (a public link) and an older app then edits and publishes that draft: the publication before is still the one named. It also needs the version before, which readers don't have for their oldest version. Rejected for decision 2.
- **Load labels for the whole history.** Simpler UI, but a page ticked daily for a year would download and decrypt 365 versions each time history opens. Rejected for 20 at a time.
- **Fold runs into one row that adds up their counts.** A box ticked in one version and unticked in the next would read as both, and View and Restore would need to say which version they mean. Rejected for decision 5's row, which keeps the newest version's own label.
- **Labels in the CLI's `page history`.** The CLI lists records only. Left out; it can come later with the same helper (`changeOf`).

## Consequences

- Protocol section 5.5 gains `wikistow.change`, and section 13's list of namespaces dropped on purpose gains it. `wikistow.md` says history labels these versions.
- `commitFor` takes the revision ID, and `publishPage` takes what changed.
- History opens up to 20 versions when it opens, and 20 more each time the person asks, where it opened none before.
- Versions published before this change, or by an app from before it, have no label.

## Decided (2026-10-31)

Scott chose option 1, the payload extension, on #213.

## Implementation

One pull request: this ADR and the protocol text, then the client, the flush and history.
