---
status: accepted
---

# Merging conflicting edits

When someone saves a page's draft while another person is editing it, or an offline edit meets a change made meanwhile, the draft view stops at a conflict. Today the person must pick one version: **Save mine on top** replaces the other person's changes in the draft, and **Discard mine and view theirs** throws their own away (#334). This ADR decides how the app merges the two instead: a three-way merge of the page's Markdown by block, with its front matter merged by key. Changes to different parts of the page combine on their own. Where both changed the same part, the person sees theirs and the other person's side by side, and picks one or edits. The person reviews the merged draft, with what it changes coloured, before it is saved.

In short:
- **Where.** The conflict prompt gains **Merge…**, first, beside the two choices it has. It is offered wherever the prompt shows: a draft someone else saved (`stale-head`), a change from this device's offline queue that came back as a conflict, and another window's change waiting on this device.
- **What merges.** The draft the person's edit was based on (the base), theirs as it is now, and the person's own. Everything happens in the client, on plaintext. Nothing changes on the server or in the protocol.
- **By block.** The body is cut into blocks: paragraphs, headings, each list item, each table row, each code block. A block changed on one side only takes that side. Both sides adding at the same place keeps both. Both changing the same block is an overlap for the person.
- **Front matter by key**, the title as one field, attachments by ID, the banner and icon by field, plugin data by namespace.
- **Review before saving.** The merged draft shows as what saving changes in theirs. **Save merged draft** saves it on top of theirs, as **Save mine on top** does with the person's own text today.

## What the code supports today

- **The conflict prompt.** A save over a draft someone else saved is `stale-head`, and so is a draft head the live tree names that this session didn't make (`noticeHead`, `packages/ui/src/page/draft-session.ts`). The draft view then offers **Save mine on top** (`saveMineOnTop`, which sets the session's base to theirs and saves) or **Discard mine and view theirs** (`onReload`) (`packages/ui/src/page/draft-editor.tsx`).
- **The offline queue** (ADR 0009, decision 7). A draft entry whose base isn't the draft head any more stops as `conflict` (`packages/client/src/operations/queue.ts`). The shell's note lists it, and opening it opens the draft view with the entry's text as unsaved changes and the same prompt (`useDraftSession` passes `queued.theirs`). Another window's change saved into the queue is a conflict there and then (`conflictWithDevice`), and **Discard mine** keeps that window's change. A publish waiting for the page stops with its draft's conflict (`PUBLISH_CHANGED`).
- **The base is at hand.** The session knows the server draft its text is based on (`#base`). While the page has an offline entry, the session saves into the entry and `#base` stays that server draft, and the keeper keeps it until the entry is resolved (ADR 0009, decision 3; `OfflineQueue.bases()`). The session's `#payload` is not the base: after a save into the queue it is the person's own queued text, and a view opened from an entry starts with the entry's payload.
- **Theirs** is the page's draft head, which **Discard mine and view theirs** already opens, or the other window's queue entry.
- **A payload** (`packages/client/src/payload.ts`) is a title, the Markdown (front matter included), the attachments list with each file's key, and namespaced extensions: the link table (`wikistow.links`), the banner and icon (`wikistow.cover`), plugins' data, and others. `wikistow.change` is written only by a publication, never into a draft.
- **Parsing.** `packages/client/src/markdown` reads Markdown with `mdast-util-from-markdown`, GFM, its own math rule (Pandoc's dollars) and wikilinks, which give every node's place in the source. Front matter is split off first (`splitFrontmatter`) and read with `yaml`, which keeps every key's and value's place too, so a value can change by its characters alone (ADR 0006, decision 3).
- **No diff code of the app's own.** `diff` (jsdiff 8.0.4) is in the lockfile only through the router's build plugin. `@milkdown/plugin-diff` comes with `@milkdown/kit`, unused: it reviews a two-way diff inside the visual editor. The theme colours removed lines in highlighted code (`--code-deletion`), but has no colours for added and removed text in a page.
- **Folder renames already merge by field.** A rename that meets someone else's shows **Yours** or **Theirs**, and Yours is drawn as theirs with the person's changes on top (ADR 0009, decision 7). This ADR leaves it as it is.
- **The spec** says of a draft conflict: "The client preserves its unsaved text and presents the competing revisions … Do not silently merge or retry with a newer base" (`wikistow.md`, Drafts). A merge the person reviews isn't silent, so that rule stands.

## Decisions

### 1. Where a merge is offered

**Merge…** comes first in the conflict prompt, before **Save mine on top** and **Discard mine and view theirs**, which stay. It is offered wherever that prompt shows:

- a draft someone else saved while this person was editing, in another tab too, or the chat assistant's approved edit landing while they type;
- an offline change that came back as a conflict, opened from the shell's note;
- another window's change waiting on this device.

It isn't offered when theirs can't be read (`newer-format`), or when there is nothing of the person's to merge: no unsaved text and no offline entry for the page (the prompt then says "Someone else saved a newer version of this draft"). Text saved into an offline entry counts as the person's, though the session has nothing unsaved, so the prompt's own test in `draft-editor.tsx` becomes unsaved text or a draft entry for the page waiting. That is narrower than the `onDevice` it has at hand, which is true for any change waiting for the page, a move or a publish too, where there is nothing of the person's in the text. `DraftSession.hasUnsaved()` itself stays as it is, since leaving the page and locking use it, and text in an entry is safe. A cell in a folder table that conflicts still says **Open the draft**, as today: one value has nothing to merge. The CLI, agents and plugins still get the conflict as a refusal, since a merge needs a person to confirm it. A publish stopped by its page's conflict still says so with **OK**, and the person publishes again after the merge.

### 2. The three versions

- **Base**: the server draft the person's text was based on: the session's `#base`, opened from the revision cache, or from the kept store offline. For an offline entry, that is its kept base. For another window's change, the base is the entry as this session last saved or opened it (the session's `#payload`), since both windows' text grew from it; the entry's own server base would show the edits both windows share as overlaps.
- **Theirs**: the page's draft head now, opened as **Discard mine** opens it, or the other window's entry.
- **Yours**: what the draft view holds, the person's unsaved text included.

The merge reads only these plaintext payloads, in the client. Nothing new goes to or comes from the server, so the protocol doesn't change. Saving the result is an ordinary save on top of theirs (decision 7).

### 3. Blocks

The body (the Markdown after the front matter) is cut into blocks, parsed with the app's own parser in `packages/client/src/markdown`, as the reader parses it (CommonMark, GFM, its math rule, wikilinks). A block starts at the line where each of these starts:

- a leaf block: a paragraph, heading, fenced or indented code block (a Mermaid diagram is one), math block, HTML block or thematic break;
- a list item, at any depth. A nested list's items are blocks of their own, so the parent item's block is its own lines only;
- a table row. The header row and its delimiter row are one block, so a new column changes every row;
- each block inside a block quote or an alert.

Blank lines between blocks are blocks of their own. Each block is its exact source text, markers and indentation included, so joining the blocks gives the page back byte for byte (checked on all 236 pages of the spike). Blocks are compared by what they read as, not by their characters, as the visual editor's fidelity check compares whole pages (`meaning` in `packages/ui/src/page/editor/visual/reader-fidelity.ts`). That is because once anything changes, the visual editor writes every block of the page again in its own style: tables aligned, ordered lists numbered in order, `-` bullets, `*` emphasis, its own indentation and heading marks. By characters, one tick in the visual editor on a page imported from Obsidian, or written in the source editor, would change many blocks, and each would overlap with the other side's edits. A block reads as two things together:

- **Its own content:** its node from the page's parse, without positions. A list item is only its own lines: its first paragraph, whether it is a task, and whether it is ticked (`checked`: null, false or true), not its other children, which are blocks of their own. The header block of a table includes the table's column alignment.
- **Its place:** the containers it sits in, outermost first, each with what changes how it reads: a list (bulleted or numbered, and its nesting depth) or a block quote or alert (and the alert's kind).

So indenting an item, turning a bulleted list into a numbered one, or a list into a checklist, is a change to each block it touches, and isn't lost. Also, a body whose last line has no line ending is given one first, so two people each adding a paragraph at the end of such a page aren't both changing its last block. The merged body ends as theirs does, with or without one.

### 4. The merge

A three-way merge over the three lists of blocks (diff3):

- Base is aligned with yours, and base with theirs, by their longest common sequence of blocks. A run of blocks one side replaced, removed or added is that side's change.
- A change from one side only is taken.
- The same change on both sides is taken once.
- Changes on both sides to the same base blocks overlap, and the person chooses (decision 6).
- **Runs split into single blocks.** The alignment gives each side's change as a run of neighbouring blocks, such as ticks on items 2 to 5 of a tight checklist. Before the two sides are compared, a run that replaced its base blocks one for one is split, on each side by itself, into one change per block. So ticking items 2 to 5 while Sam ticks item 4, or adds an item between 4 and 5, is no overlap; Sam editing item 5's words overlaps on item 5 alone, and Sam removing item 3 on item 3 alone. A run that also added or removed blocks (ticking items 2 to 5 and adding "milk" after them, in one visit) isn't split, since which old block each new one replaces is then a guess, and a guess that is wrong offers the person the wrong pair. Such a run stays one change, so a change by the other side inside it overlaps the whole run, and the person picks or edits.
- Changes to neighbouring blocks don't overlap: a person ticking one task while another edits the next one is not a conflict.
- **Both adding at the same place** (two people each adding an item at the end of the same list, or a row at the end of a table) keeps both, theirs first. Blocks that both additions start or end with appear once, so two people who each add the same `#### CLI` heading with an item under it get one heading. The review (decision 7) shows the order chosen.
- **Joining two sides' blocks**, here and for **Use both** (decision 6), puts a blank line between them unless both are list items or table rows, so two paragraphs never run into one.
- **Writing the merged body.** A block that reads the same on both sides is written as theirs has it, and a block one side changed as that side has it, with one adjustment for lists, since in Markdown a new bullet character starts a new list: a list item is written with the bullet or number style, and the indentation for its depth, of the list it lands in. A table that took rows from both sides is written aligned again if theirs' was, only so it reads well in the source editor.
- **Checking it.** Before every review, with overlaps or without, the body is written and parsed again, and each block must read as it was chosen, in its place, the list it is in included. One that doesn't (an item of a bulleted list landing in a list the other side made numbered, say) goes to the choosing step as an overlap, "This didn't fit where it went", with yours, theirs and **Edit…** (no **Use both**), rather than being saved reading differently. A side picked there is written exactly as that side has it, with no adjustment, and taken as it then reads, without checking it again: a top-level item then starts a list of its own, and a nested one may land at another depth. The review shows how it reads, and **Edit…** is there to place it by hand. Text from **Edit…**, at any overlap, is written as typed and taken as it reads too. So the merge parses at least four times: the three versions, and the merged body. The review (decision 7) compares by what blocks read as too, so a change of style alone never shows.
- A block one side moved is, to the merge, a block removed and one added. If the other side edited that block, the removal and the edit overlap.

Nothing is merged inside a block. Two edits to different words of one paragraph overlap, and the person chooses (Decide 3).

### 5. The title, front matter, attachments and other data

- **Title**: one field. Changed on one side, it takes that side; changed on both, it is an overlap.
- **Front matter by key** (ADR 0006): each top-level key of the block. A key changed, added or removed on one side takes that side. A key changed on both sides to different values is an overlap, shown as that key's line. A list of plain values (`tags`) changed on both sides merges by item instead: an item either side added is kept, and one either side removed goes, with only that value written again in theirs' style. The merged block starts from theirs' exact text, and each of yours' changes replaces only its key's characters, as an edit through the property rows does. A key yours added goes after the key it follows in yours. A block that isn't a map of keys on any side is one field, like the title.
- **Attachments by ID**: those on either side, less any either side removed, unless the merged payload still names one: in its text, its banner or icon, or other data.
- **The link table** (`wikistow.links`): both sides' entries, theirs taking precedence for the same link text. The save trims it to the links the text uses, as every save does.
- **Banner and icon** (`wikistow.cover`): the banner is one field, and the page's icon is another, whether an emoji, an icon from the set or an image, since the page shows only one. Both sides changing the same one is an overlap, shown as the two pictures.
- **Other data**, such as a plugin's or an import's, by namespace. Changed on both sides, it is an overlap naming it ("Data Recipe cards keeps for this page"), with yours or theirs and no editing.

### 6. Choosing where both changed

The draft view's page card shows the merge in place of the editor, titled "Merge your changes with Sam's". Theirs is named by who saved it, from the revision's `authorId`, as the app names people and agents elsewhere: "your other version" when it was saved under the person's own name, in another tab, on another device, or as a chat edit they approved, "your other window" for this device's other window, and "the other version" when the app can't tell. With no overlaps, and no block that failed decision 4's check, it goes straight to the review (decision 7). Otherwise it says how many changes combined on their own and how many places both changed, then lists each overlap in page order:

- the heading it sits under and its number ("Method · 2 of 2"), and the block before it, dimmed, for context;
- **yours and theirs side by side**, each as its Markdown source, with the words it changed from the base marked: added in green, taken out in red and struck through;
- **Use yours**, **Use Sam's**, **Use both** (theirs, then yours) and **Edit…**, which opens a text field with yours in it, or theirs where yours has nothing there, already written in the bullet style and indentation of the list it lands in (decision 4), to change before using. The chosen button stays marked.
- **Use both** is for blocks of the body only, and not at a block that didn't fit (decision 4). The title and a front matter key offer yours, theirs and **Edit…**, since both would make two titles or a key written twice. The banner, the icon and other data offer yours and theirs only.

**Review merged draft** is enabled once every overlap has a choice. **Cancel** goes back to the conflict prompt with nothing changed. On phones the two sides stack, yours above theirs, and the four buttons sit in two rows.

```
Computer                                         Phone
┌──────────────────────────────────────────────┐ ┌──────────────────────────┐
│ Merge your changes with Sam's                │ │ Merge your changes with  │
│ (1 · Choose) (2 · Review)                    │ │ Sam's                    │
│ 4 of your changes and 3 of Sam's combined.   │ │ (1 · Choose) (2 · Review)│
│ You both changed 2 places.                   │ │ ┌──────────────────────┐ │
│ ┌──────────────────────────────────────────┐ │ │ │ Ingredients · 1 of 2 │ │
│ │ Ingredients · 1 of 2                     │ │ │ │ - 1 onion, chopped   │ │
│ │   - 1 onion, chopped small               │ │ │ │ Yours                │ │
│ │ ┌ Yours ────────────┐ ┌ Sam's ─────────┐ │ │ │ │ - [-500-]{+400+} g   │ │
│ │ │ - [-500-]{+400+} g│ │ - 500 g [-beef-]│ │ │ │ │   beef mince         │ │
│ │ │   beef mince      │ │   {+lamb+} mince│ │ │ │ │ Sam's                │ │
│ │ └───────────────────┘ └─────────────────┘ │ │ │ │ - 500 g [-beef-]     │ │
│ │ [Use yours] [✓ Use Sam's] [Use both]     │ │ │ │   {+lamb+} mince     │ │
│ │ [Edit…]                                  │ │ │ │ [Use yours][✓ Sam's] │ │
│ └──────────────────────────────────────────┘ │ │ │ [Use both] [Edit…]   │ │
│ 2 of 2 chosen      [Cancel] [Review merged…] │ │ └──────────────────────┘ │
└──────────────────────────────────────────────┘ │ [Cancel] [Review merged] │
                                                 └──────────────────────────┘
```

(`[-…-]` is text taken out, in red; `{+…+}` text added, in green.) Rendered mockups at both sizes are in the PR.

### 7. Reviewing and saving

The review shows the merged draft as what saving changes in theirs, since theirs is the draft as it stands: "Saving makes these changes to Sam's draft." The Markdown shows block by block:

- a changed block once, with its changed words marked;
- an added block in green, with `+`;
- a removed block in red, with `−`;
- runs of unchanged blocks folded to one line ("⋯ 9 unchanged lines"), which opens them.

Under it, one line each names what the merge changes in theirs' title, banner, icon, attachments and other data ("Icon: yours"), and nothing when it keeps theirs. **Save merged draft** saves; **Back** returns to the choices, as they were; **Cancel** goes back to the conflict prompt.

```
┌────────────────────────────────────────────────┐
│ Saving makes these changes to Sam's draft.     │
│ ~ tags: [recipe, dinner, easy{+, favourite+}]  │
│ ~ servings: [-6-]{+8+}                         │
│   ⋯ 9 unchanged lines                          │
│   - 2 cloves garlic                            │
│ + - 1 tsp dried oregano                        │
│   - 1 bay leaf                                 │
│   ⋯ 14 unchanged lines                         │
│ ~ 6. … bake at [-180-]{+190+} °C for 45 …      │
│ − Use fresh sheets if you can get them; …      │
│ Icon: yours                                    │
│              [Back] [Cancel] [Save merged draft]│
└────────────────────────────────────────────────┘
```

**Saving** goes on top of theirs, as **Save mine on top** does, but the session first takes the merged payload whole, not only its text: its title, Markdown, attachments and extensions, with theirs' link table region. Today's **Save mine on top** builds its save from the session's own payload, so a banner Sam changed would go back to the base's. The session then takes as its base the revision the merge read as theirs, and saves at once. That is not always what **Save mine on top** saves on: it takes the newest head it has heard of, which may have moved on while the person was choosing. Based on the version the merge read, a save over a newer one is `stale-head`, as below. For another window's change, the save names the entry version the merge read as the one it saw. The editor shows the merged draft, and typing goes on from there. For an offline entry, the save goes into the entry and onto theirs as **Save mine on top** does today (`onTopOf`, then the queue's `onTop` rebase), and the sender sends it. If someone saved again meanwhile, the save is `stale-head` as usual, and **Merge…** merges again, with the draft that was theirs as the base: before the save, the session's base is theirs as read, and for another window's change the payload it compares against is that entry version, with the merged text on top as the person's. Nothing is written until **Save merged draft**, and the person's own text stays in the editor until then, so leaving the merge loses nothing.

### 8. Code

- **`packages/client/src/merge/`**, plain functions with no UI:
  - `blocksOf(body)`;
  - `mergeBlocks(base, yours, theirs)` returning the merged blocks with the overlaps marked;
  - `mergeFrontmatter` by key;
  - `mergePayloads(base, yours, theirs)` for the whole payload, returning the merge and its overlaps;
  - `resolve(merge, choices)`, which writes the merged body, checks it (decision 4), and returns either the payload to save or the blocks that didn't fit, as new overlaps.
- **The alignment and the word marks** use `diff` (jsdiff): `diffArrays` over blocks, and `diffWordsWithSpace` for the marks in decisions 6 and 7. The three-way step on top of it is under 100 lines of the app's own (Decide 5).
- **`packages/ui/src/page/merge/`**: the merge view inside the draft view, and the review. `DraftSession` gains a way to take a whole payload and save it on top of theirs (decision 7).
- **Theme tokens**: `--diff-added`, `--diff-added-foreground`, `--diff-removed` and `--diff-removed-foreground` join `theme.css`'s one token source, for every palette, so plugin themes can set them.
- **Cost**: the merge parses the three versions of one page, and the merged body before the review. The spike parsed a 5.5 KB page in 50 to 90 ms, so a merge of an ordinary page is a moment's "Merging…". If long pages make phones wait, it moves into the reader's Markdown worker.

### Out of scope

Merging when no person is there to confirm (the CLI, agents, plugins); merging folder renames, which already go by field; merging into an older version from history; live editing together (#321), which would avoid most conflicts rather than merge them; merging inside a block (Decide 3).

## Spike evidence (2026-11-08)

A throwaway script (not committed) cut pages into blocks as decision 3 says, merged them as decision 4 says, and compared the result with a line merge (`git merge-file`).

Its limits: it parsed with `micromark-extension-math` rather than the app's own math rule and wikilinks, so the build checks the cuts again with the app's parser. Its first run's edits were typed as in the source editor; the second run, below, covers the visual editor's tables and lists. Its edits never added at the very end of a page without a final line ending, and it joined kept additions without decision 4's blank line. Both rules came from review after it, and were then checked on small cases (two paragraphs, list items and table rows added at one place, a page with no final line ending) and on the real history, whose numbers didn't change. Decision 3's comparison by what blocks read as, with their place, decision 4's splitting of runs (checked on small cases and the real history, unchanged) and its check of the written body also came from review; the spike tested only the part of them that leaves out table padding and item numbers (below). Its front matter check rebuilt the block from each key's text, so it counts stops but doesn't test where a new key goes.

**Splitting.** On all 236 pages below, the blocks joined back into the page byte for byte.

**Real concurrent edits.** This repo's merge commits give 89 cases where both sides changed the same Markdown file since their common base: `CHANGELOG.md` 39, `wikistow.md` 27, `ui-design.md` 11, `protocol.md` 7, and 5 in other files. The merge commit holds what a person, or an agent, made of them.

| | Cases |
| --- | --- |
| Line merge combines them, and so does the block merge, the same way | 58 |
| Line merge stops at a conflict | 31 |
| … block merge gives exactly what the person made | 6 |
| … block merge gives the same lines in another order, or a blank line more or less (two additions at one place) | 14 |
| … block merge places items differently around headings one side added (a release reshaping `CHANGELOG.md` while the other side added items) | 5 |
| … block merge stops too: both sides changed the same paragraph or table row | 6 |

So the block merge stops 6 times in 89 where the line merge stops 31 times, and each of its 6 is a real overlap. The 5 placed differently are the kind of result decision 7's review is for.

Two rules came from these cases:
- **Keeping both additions whole, theirs first**, at first made two `#### CLI` headings where two people each added that heading, so blocks both additions start or end with now appear once.
- Lining the two additions up block by block instead put one side's item under the other side's new heading, a quiet wrong result, so only a shared start or end is joined.

**Simulated edits.** 236 pages:
- 8 pages written for the spike in the shape of a family wiki: a recipe, a packing checklist with a table, a budget table, club minutes, a reading list, birthdays, a garden plan and house notes;
- 78 sections of this repo's docs;
- 150 READMEs from `node_modules` that have lists or tables.

Each case makes two single edits to the same page, one per side, of one category:
- lists: change an item's words, add an item, tick a task, remove an item, add at a list's end;
- tables: change a cell's words, add a row, add at a table's end;
- paragraphs: change a word, add a paragraph.

"Near" puts both edits in the same list, table or section; "anywhere" anywhere on the page. The table counts cases where the two edits touch different blocks, so a merge should combine them, and how often each merge stopped anyway (a false conflict).

| Category | Placement | Cases | Line merge stops | Block merge stops |
| --- | --- | --- | --- | --- |
| Lists | near | 550 | 161 (29%) | 0 |
| Tables | near | 587 | 202 (34%) | 1 (0.2%) |
| Paragraphs | near | 539 | 94 (17%) | 1 (0.2%) |
| Lists | anywhere | 575 | 88 (15%) | 0 |
| Tables | anywhere | 590 | 156 (26%) | 0 |
| Paragraphs | anywhere | 575 | 33 (6%) | 1 (0.2%) |

- Every false conflict of the line merge in lists and tables was between neighbouring lines, or two additions at the same place. Where both sides added at the same place (222 cases near), the line merge stopped on 221.
- Where the block merge combined, its result was the one expected, with one exception in 3,416 cases: two paragraphs added at the same place ran into one, with no blank line between them. Decision 4's joining rule comes from it.
- The block merge stopped in 3 of the 3,416 cases, all from the spike's own edits: a row added without the indent of a table inside a list item, and an LF line break added to a page with CRLF line breaks, which each changed a neighbouring block.
- The line merge never gave a wrong result where it combined.

**As the visual editor writes.** The edits above are typed as in the source editor. The visual editor instead writes every table it changes aligned, and numbers ordered lists in order. A second run made the pages and both sides' edits that way (near placement only), and compared blocks by exact text and with table rows' padding and ordered items' numbers left out, which is what decision 3's comparing by what blocks read as does for these two:

| Category | Cases | Line merge stops | Exact blocks stop | Padding and numbers left out |
| --- | --- | --- | --- | --- |
| Lists | 550 | 175 (32%) | 9 (1.6%) | 0 |
| Tables | 587 | 280 (48%) | 100 (17%) | 3 (0.5%) |

The 3 table stops, and the one wrong result in that run, come from the spike's edits: text added after a row's last bar, which makes a new column, and a row added without the indent of a table inside a list item. Comparing by exact text would have made a table edited in the visual editor an overlap one time in six. The run started from pages already in the editor's style; on a page that isn't, the editor's other rewrites (bullets, emphasis, indentation, heading marks) add more such changes, which decision 3's comparison covers the same way. The build measures that with the app's own parser and editor.

When both edits fell in the same block, at different words (near: 19 list items, 10 rows, 59 paragraphs), the block merge stops by design. A word merge inside the block would have combined 77 of those 88 cases correctly in the simulation. On the real history it combined 5 of the 6 real overlaps: 4 as the person did, and 1 into a broken sentence that read as fine to the merge. One side had removed a sentence's first words and the other had rewritten them, and the result started "comments, simultaneous live editing…" in lower case. That is the reason for Decide 3.

**Front matter.** Front matter is a few lines next to each other, so a line merge stops on almost any two edits. On the 5 spike pages with tags:

| Both sides… | Line merge stops | By key stops |
| --- | --- | --- |
| add a different tag | 5 of 5 | 0 |
| edit two neighbouring keys | 4 of 4 | 0 |
| add a different key at the end | 5 of 5 | 0 |
| change the same key differently | 5 of 5 | 5 (right) |

**Libraries.**
- `node-diff3` (MIT) does the three-way step, but stops at every pair of additions at one place, and has no word diff, which the marks need anyway.
- `diff` (jsdiff, BSD-3, no dependencies, its own types) has both an array diff and a word diff.
- The spike's own three-way step over a common-sequence alignment was under 100 lines.

## Considered options

- **A line merge** (`git merge-file`, or `node-diff3` over lines). Standard and simple, but it stops at neighbouring lines, which in Markdown are a list's items, a table's rows and front matter's keys: 15% to 34% false conflicts in lists and tables, and 31 of 89 real cases against the block merge's 6.
- **Conflict markers in the source editor**, as git does. No new view, but the visual editor would show the markers as text, the person has to know the syntax, and a marker left in by mistake is saved. Rejected for side by side, as decided on #334.
- **Merging inside a block by words.** Fewer overlaps, but a quiet wrong result on the real history. See Decide 3.
- **Reviewing inside the visual editor** with `@milkdown/plugin-diff`, already in the tree. It shows a two-way diff with accept and reject in place, but only in the visual editor, and a page that stays in source mode couldn't use it. The three-way step is needed either way.
- **Merging the editor's document tree** (ProseMirror steps) instead of Markdown. It would follow the visual editor's structure, but the source editor, offline entries and other windows hold Markdown, not steps, and a page the visual editor can't round-trip stays in source mode.
- **Saving the merge without a review** when nothing overlaps. Fewer clicks, but the real history shows results that combine cleanly and still read wrong. Decided on #334: the person always reviews.
- **Merging on the server.** The server can't read pages.
- **Keep both as a separate page**, rejected in ADR 0009.

## Consequences

- Now, with this ADR: `wikistow.md`'s Drafts section and ADR 0009's Out of scope line point here, and `CONTEXT.md` gains **Conflict** and **Merge**.
- Once built: `wikistow.md`'s Drafts section says the client offers a merge the person reviews, and its rule against silent merging stands. Its Offline section, and ADR 0009's decision 7, name **Merge…** among the conflict's choices. `ui-design.md` gains a Merge section with the two steps, the phone layout and the diff colours.
- `packages/client` gains the merge module and the `diff` dependency. `packages/ui` gains the merge view, and `theme.css` the diff tokens.
- Nothing changes on the server, in the protocol, or for the CLI, agents and plugins.

## Decided (2026-11-09)

Scott accepted every recommendation below on 2026-11-09.


1. **Keep Save mine on top and Discard mine beside Merge…?** Recommended: yes, with **Merge…** first. Save mine on top is still the quick way when the person knows theirs should win, and Discard mine when theirs should.
2. **Two additions at the same place: keep both without asking?** Recommended: yes, theirs first, with blocks they both start or end with shown once (decision 4). The spike's line merge stopped on 221 of 222 of these, and they are the most common case in lists and tables. The review shows the order.
3. **Merge inside a block, by words?** Recommended: no, not now. It would have combined most same-block overlaps, but it made a broken sentence from a real conflict without saying so. The side-by-side view with marked words makes the choice quick, and **Edit…** covers combining both.
4. **Show the blocks as Markdown source, or drawn as the reader draws them?** Recommended: source first, with marked words. It is exact, shows what is saved, and works for every block kind; a drawn view needs a diff over drawn output, and could come later.
5. **The `diff` library, or the app's own code?** Recommended: `diff` (jsdiff) for the alignment and the word marks, with the three-way step the app's own. Writing a word diff that handles spacing well is more code than it saves.
6. **Review against theirs, or colour each change by who made it?** Recommended: against theirs (decision 7), because that is what saving changes and what history will show. Changes theirs made then read as unchanged text.
7. **Use both on overlaps?** Recommended: yes, theirs then yours. It is the common answer for two list items or paragraphs, and on phones it saves copying text by hand.
8. **Front matter lists merged by item?** Recommended: yes for lists of plain values such as tags (decision 5). Two people adding tags is common and never really a conflict.

## Implementation, in pull requests

1. **This ADR.**
2. **The merge module.** `packages/client/src/merge/`, the `diff` dependency, and unit tests: blocks join back byte for byte; the spike's cases (neighbouring items, additions at one place, a shared heading, a moved block, a table re-aligned, a list renumbered and a page restyled by the visual editor, an item indented, a list turned from bullets to numbers, an item from a `*` list placed among `-` items, a run of ticks on one side against a single tick, an edit, an item added and an item removed inside it on the other, and a run of ticks with an item added at its end against a tick inside it (one overlap), a list turned into a checklist, the check of the written body sending a block that reads differently back as an overlap, and a nested item picked there landing at another depth, front matter by key, tags by item, attachments, cover, unknown data); and payloads round-trip through `resolve`.
3. **The merge view, online.** **Merge…** in the conflict prompt for a draft someone else saved, the choosing step, the review, saving on top of theirs, the diff tokens, and the spec. An e2e with two browser contexts editing one page, merging, and saving.
4. **Offline and other windows.** **Merge…** for a queue entry that came back as a conflict (its kept base) and for another window's change, the entry taking the merged payload. An e2e: an edit offline, a change online meanwhile, then the merge.

Step 3 needs step 2, and step 4 needs step 3.
