---
status: accepted
---

# Moving and copying pages and folders between spaces

People want to move a page or folder into another space, and to copy one, into another space or the same one. The spec rules this out: "Treat a move into another space as an explicit copy or publication, not an ordinary rename" (`wikistow.md`, Sharing), and protocol section 10 ends "A move into another space isn't a move; it is a copy or a publication". This ADR replaces both rules. A move between spaces becomes a copy that deletes its source in the same transaction. The same machinery, without the delete, gives **Copy to…**.

In short:
- **Move to…** and **Copy to…** take a page or folder, with everything under it, to any folder or the top of any space where the person can make pages. Copy also works within one space. Moves within one space stay as they are (protocol section 10).
- Each page brings its current draft and current published version, sealed again for the destination by the person moving it. Folders bring their current name and look. Earlier history doesn't come: a move deletes it with the source.
- The app makes the destination nodes hidden, uploads their records and attachments in as many requests as it needs, then finishes in one request. For a move, the finish deletes the source in the same transaction. For a move, if a source page changed in the meantime, the finish is refused and the app seals the pages that changed again. If anything else changed, such as a page added to a moved folder, the app starts again from a new preview.
- A move ends what deleting the source ends: its public links, its publications into other spaces, and the shares, members and agent picks inside it. A copy changes nothing at the source.

## What the code supports today

- **Records are bound to their space.** A revision record signs `spaceId` and `pageId` (protocol sections 5.1 and 5.7), and the payload AD binds them. So no record can be carried into another space. Only its author could sign it again, and the person moving it is usually not the author of every version.
- **So are attachments.** The attachment AD binds `spaceId`, `pageId` and audience (section 5.3). A blob row names its page by foreign key to `nodes.id` (`schema/blobs.ts`), and an upload names a page that already exists.
- **Node IDs are unique across the installation** (`nodes.id` is the primary key, `schema/spaces.ts`), and a node's parent must be in its own space. So a destination node can't take its source's ID while the source exists, and attachments can't be uploaded for it until it does.
- **Cross-space publication already seals a page again for another space** (section 13, `packages/client/src/operations/publications.ts`). It opens a hidden destination page, uploads attachments resealed with the destination AD, then sends the version. Only someone who can publish the source does it.
- **Moves across a region preview the audience change** (`previewMove` and `audienceOf` in `packages/client/src/operations/moves.ts`) and send every rewrap in one request (`move` in `packages/contracts/src/routes/sharing.ts`). A folder with many saved versions is too big for that request today.
- **Deleting a node** deletes everything with a foreign key to it in the same transaction (`deleteNode`): its revisions, wraps, blobs, public links and shares. Deleting a page ends its publications into other spaces (section 13).

## Decisions

### 1. What comes along

For each page in the subtree:
- **Its current draft**, as the new page's first draft. A page with no draft, such as a publication ended without being detached, gets its published version as its draft too.
- **Its current published version**, when the page is published, as the new page's first published version. A page that was unpublished, or never published, arrives with its draft alone.
- **Every attachment those two versions list**, resealed under a fresh key with the destination AD (`attachment/v1 [installationId, T, D, audience, attachmentId]`) and a new `plainHash`, as section 13 step 3 does. Unlike a publication, nothing is left out: covers, icons and banners keep their images.

For each folder, its current name and look (one metadata version). The space's own name never moves.

Nothing else comes: no earlier drafts or published versions, no publications, no public link, no agent picks, no shares. A move deletes the source's history with the source. This was chosen over sealing every published version again as the mover, which would show one person as the author of all of history and make large pages slow.

The new records are ordinary v2 records in the destination space, written and signed by the person moving or copying. The draft has `basedOn: null`. The published version's `basedOn` names the new draft when the source's published version was made from its current draft, or the page had no draft, so a copy shows no unpublished changes where the source had none; otherwise it is `null`, as a publication's are. Neither names a version that isn't in the destination. Nothing inside the page records where it came from: a copy leaves out `wikistow.publication`, which a detached publication's versions can still hold. The audit log records the copy.

### 2. Who can do it

| | At the source | At the destination folder |
|---|---|---|
| Move | an owner of the source space | can make pages (editor or owner) |
| Copy | can read drafts of every page in the subtree (editor or owner) | can make pages (editor or owner) |

Published versions arrive published only where the person can publish at the destination. Otherwise the pages arrive with their drafts alone, and the preview says which pages will be unpublished there.

Readers can't copy. This follows the decision of 2026-10-07 for publications (`protocol-review.md`): a page's readers don't decide where it goes.

Moves are for people, with a session, as sharing is. An agent may copy where both its picks and its person allow it at the source and the destination (section 9.5).

### 3. What is refused

- **A live publication**, or a folder that holds one: a page a publication row names as its destination, with a version, and no `detached_at` (section 13). Ending a publication sets `detached_at` too, so an ended one doesn't count, and nor does an unfinished opening. Its publishers detach it first. The dialog lists the pages.
- **A destination inside the source subtree**, for a copy or a move, as for a move today.
- **A page with nothing to copy**: no draft and no published version, as when a publication was ended and then unpublished. Someone who can publish it publishes or restores a version first.
- **A move within one space.** That is the existing move of section 10, and the dialog sends it there.

### 4. The destination's region

Every new node takes the region of its parent's name record (section 6.1), as any new node does. Content keys are wrapped under the destination share's current key version, which must count for writing and pass **No going back** (sections 6.5 and 6.8), or sealed to the destination's sealing owners in the owner region. A share inside a moved folder doesn't come along: its members lose access, and the preview says so.

### 5. Links

- **Between pages that move or copy together**, a link keeps working. The app rewrites each `wikistow.links` entry that names a page of the same copy to that page's new ID, and each Markdown link to such a page's address (`/s/<space>/p/<page>`) to its new address. In a published version, the page counts as published only when its own published version comes along.
- **To any other page**, an entry is worked out again by the usual rule for the destination (section 5.5). In a copy into another space, an entry for a page of the source space never survives: those links resolve by title in the destination, or show as unresolved. Within one space, the usual rule decides. Property references (ADR 0006) follow their links.
- **Into a moved page**, links from pages left in the source space stop working. The preview lists the linking pages the person can open.

### 6. The preview

Before anything is sealed, the app shows:
- who can read and who can edit at the destination: for an owner of the destination space, worked out as section 10's preview is, from the verified envelopes of the destination's current key version, as "at least these people". Others can't fetch those envelopes, and aren't shown a share's members, so they see only the destination folder and its share. They can already write there;
- for a move, who loses access, the same way for the source;
- pages that will arrive unpublished (decision 2);
- links that won't work afterwards, wikilinks and address links (decision 5);
- for a move, what ends: public links, publications into other spaces, shares and their members, and the pages' earlier history.

A move always asks, even on a device where the person turned off confirming moves, because it deletes. A copy shows all but the items for a move. An agent's copy has no preview.

### 7. Three steps, like a publication

The protocol calls the whole operation a **copy**, of kind `copy` or `move`, since a move between spaces is a copy that deletes its source. ("Transfer" already means handing a space to another owner.)

1. **Open.** `POST /api/copies` names the kind, whether it brings published versions (which needs publish rights at the destination), the source node and its space, the destination parent and space, the permission versions of both the preview was made at (the space's, for the top of a space), and a new ID, kind and parent for every node of the subtree that the person's tree lists. The server checks decisions 2 and 3, that both permission versions are current, and that the new nodes mirror the source, and makes them, hidden.
2. **Upload.** The app uploads each page's attachments to its new node, then sends the nodes' records with their key material, in batches that fit the body limit: `POST /api/copies/:copyId/records`. Only the opener sends them. Each entry holds every record of one node: a folder's one metadata record, or a page's draft and at most one published version, which the server refuses unless the copy brings published versions; and names the source heads it was sealed from; a copy that doesn't bring published versions names no published heads, and the finish doesn't compare them. Records are stored as the hidden nodes' versions at once, so their attachments are committed and the attachment sweep leaves them alone. Sending a node again replaces what was sent for it before. Records are checked as any write is, apart from the head check: a draft's `basedOn` is `null`, and a published version's is `null` or the draft in the same entry (decision 1).
3. **Finish.** `POST /api/copies/:copyId/finish`. Under a lock on both spaces, taken in ID order, and for a move with the source subtree locked as `deleteNode` locks it, so no save lands between the checks and the delete, the server checks decision 2 again, so someone who lost access since opening can't finish, and then:
   - every new node has its records;
   - the destination parent's permission version, region and key version are those the records were written at;
   - for a move, the source node's permission version is the one sent at opening, the source subtree still holds exactly the nodes the copy mirrors, under the same parents, and every source page's heads and folder's metadata head are still the versions sealed. A draft head is always compared, so a page that gained a draft meanwhile is stale.

   It then shows the new nodes, and, for a move, deletes the source subtree as `deleteNode` does, in the same transaction. A source head that moved on is `stale-head`, naming the nodes: the app seals those again, sends them, and finishes again. `rate-limited`, which is also the answer while a publication the delete ends is being written, keeps the copy, and the app finishes again shortly. Any other failure deletes the copy, and the app starts again from a new preview. Without the subtree check, a page someone added to a moved folder meanwhile would be deleted without being copied.

**Hidden nodes** are in no tree, page route or search, and count for nothing outside their copy: not in another copy's source, and not in the records a share, a move between regions or a new co-owner must cover. Deleting or moving one of their ancestors still takes them along. So a share made at the destination meanwhile doesn't wait for the copy; the copy fails at the finish and starts again.

A finished copy is kept for a day, so a finish sent again after a lost answer gets the same answer instead of copying everything twice. Its nodes no longer belong to it, so removing it later, or a cancel sent after the finish, leaves them. The copy's references to its source don't cascade, so deleting the source never deletes the copy row: a move then fails at its finish, and a copy finishes without that node. A copy nobody finishes is swept with its nodes and blobs one day after its last request, as an unfinished publication opening is. Cancelling deletes it at once.

So a folder of any size moves or copies, which also avoids the one-request limit that section 10's moves still have.

### 8. Where it shows

- **Web and desktop:** **Move to…** and **Copy to…** in the page actions menu and in folder and page menus in the sidebar. One dialog with a space picker above the folder tree, in place of today's move dialog. Dragging between spaces in the rail stays out.
- **CLI:** `wikistow page copy` and `wikistow folder copy`. The CLI acts as its agent (decision 2), so it copies within its picks and never moves; moves stay in the app.
- **The live tree** reports the finish in both spaces.
- **The audit log** records `node.moved-between-spaces` and `node.copied`, with node and space IDs and counts only.

### Out of scope

Earlier history; moving a whole space; keeping a page's ID or address across a move; redirecting an old address to the new place; and copying a page's publications or public link.

## Considered options

- **Seal all of history again as the mover.** It keeps the versions, but shows the mover as their author and is slow on large pages. Rejected (decision 1).
- **Keep the page IDs.** Links and addresses would survive, but attachments can only be uploaded to a node that exists, and the source holds the ID until the finish. It would need staged blobs without a page. Rejected for the link rewrite in decision 5.
- **Carry provenance inside the page**, like `wikistow.publication`. Nobody can check it once the source is gone, and every later save would carry it. The audit log records the move instead.
- **One request**, as section 10 sends. Simpler, but a folder of any size would hit the body limit. Rejected for decision 7's three steps.

## Consequences

- `wikistow.md` changes in Sharing (the cross-space move rule) and the capability table (copy). Protocol section 10 gains **Copies, and moves between spaces** in place of its last bullet; A10, sections 5.5, 9.5, 9.6 and 13 mention copies. `CONTEXT.md` gains **Copy**.
- The server gains a `copies` table, a hidden state for nodes, three routes and a cancel, a sweep, and changes to the tree reads and coverage checks so hidden nodes stay out.
- The client gains a copy operation built from the publication sealing and the move preview.
- Readers in the destination see new pages appear in one step. Readers at the source of a move see them go in the same step.
- An app that fails part-way leaves a hidden copy until the sweep. Nobody sees it.

## Decided (2026-10-30)

Scott chose, on #217:
- the current draft and published version only, with earlier history left behind;
- pages and folders both;
- moves for owners of the source space who can make pages at the destination, with published versions arriving published only where they can publish;
- refusing publication copies until they are detached;
- **Copy to…** alongside **Move to…**, the same operation without the delete;
- readers can't copy, and the CLI copies but doesn't move.

## Implementation, in pull requests

1. **This ADR, the spec and the protocol.**
2. **The server:** `copies`, hidden nodes, the routes and the sweep, with integration tests, including the content-leak sweep for a copy's hidden nodes.
3. **The client operation:** planning, preview, sealing, upload, finish and stale retries, with integration tests against the real server.
4. **The dialog and menus,** with e2e tests for a move and a copy across spaces.
5. **The CLI copy commands.**

Step 3 needs step 2; steps 4 and 5 need step 3.
