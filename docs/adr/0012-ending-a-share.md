---
status: accepted
---

# Ending a share

An owner can share a folder or a space, but can never stop sharing it (#329). Removing every member doesn't help: the folder stays a share root, so the folder above it can't be shared either, since shares don't nest (protocol section 6.1). This ADR decides how an owner stops sharing a folder or a space, so that it is the owners' alone again, as if it had never been shared, and the folder above it can be shared. It also answers #328's question for this case: whether a very large share, move or ending must be sent in parts now.

In short:
- **Stop sharing** is in the Share dialog of a shared folder or space, for its owners. It works like moving the folder out of its share without moving it: the owner's app opens every record wrapped under the share's keys and seals each again to the space's owners, as a move into the owner region does (protocol section 10), then sends it all in one request. The server deletes the share, its members, its groups' access, its agents' picks and its keys in the same transaction.
- **Former members keep what they had**: every key version of the share, and so whatever they read or downloaded, as anyone removed from a share does. Nothing saved afterwards reaches them, but through a public link an owner turned on, which stays, or a publication into a space they can read.
- **What ends with it:** every member's and agent's access, the groups' access to that folder (the groups stay), and the public links and public copies of people who can no longer publish the page. Publications into other spaces stay, and from then on only owners send or end them.
- **Writers who haven't heard** are refused by the checks every write already meets: the permission version, then access, then the region of the key material.
- **The trash** comes along: what was deleted from under the share is sealed to the owners too, so it can still be restored.
- **Sending in parts (#328) isn't needed yet.** At about 400 bytes a record for each owner, one request holds tens of thousands of records, several times a family's largest space.

## What the code supports today

- **Shares are made, filled, rotated and moved across, never ended.** `packages/server/src/content/sharing.ts` has `makeShare`, `addMember` and `rotateShare`; nothing deletes a `shares` row but deleting its root for good. Taking people out of a share, directly or through a group (`groups.ts`), rotates it. The Share dialog (`packages/ui/src/sharing/share-dialog.tsx`) has no **Stop sharing**.
- **The nesting rule** is `requireNoNesting` in `sharing.ts`, which counts every share not rooted in the trash, and the move route's own check of the space's shares in `moves.ts`.
- **Moving out of a share already rewraps into the owner region.** A move across a region boundary (`previewMove`, `moveNode` and `rewrapper` in `packages/client/src/operations/moves.ts`) opens every retained record of the subtree, seals each to the owners in v2 envelopes, and sends them in one request, retrying on `stale-head` for versions saved meanwhile. The server (`moveNode` in `packages/server/src/content/moves.ts`) replaces the wraps under the space lock. Ending a share is the same rewrap, with no change to the tree.
- **The scan route** (`scanRecords` in `sharing.ts`) lists records in parts for an owner, by subtree or by key material (`owner-region`: every record without a wrap, but a copy's hidden nodes', the trash included).
- **Wraps and folder key envelopes cascade with their share.** Deleting a `shares` row deletes its `revision_wraps`, `metadata_wraps`, envelopes, members and grants.
- **The trash keeps its records under the keys they had.** A node deleted from under a share keeps its wraps, and restoring it checks they still fit where it goes (protocol section 10, **The trash**).
- **Public links end when their sharer can't publish the page** (ADR 0005, decision 8), in the transaction of the change that took the right away.
- **The offline queue** seals each draft when it is sent, in the region of that moment, but a folder rename in the region it was queued in (#359), and treats `not-found` and `forbidden` as a page out of reach (ADR 0009, decision 7).
- **One request is capped at 64 MiB** (`BULK_BODY` in `apps/server/src/routes/content.ts`), for making a share, a move and adding a co-owner. Past it the server answers `payload-too-large`.

## Decisions

### 1. What Stop sharing does

An owner stops sharing a folder share or the space share. Afterwards:
- **The folder and everything in it are in the owner region** (protocol section 6.6), sealed to the space's owners, as if it had never been shared. For a space share that includes the space's name.
- **The share is gone.** Its members, its groups' access to it, its agents' picks, the people waiting for its keys, its folder key envelopes and its wraps are deleted. The groups themselves stay, with their other folders.
- **The nesting rule no longer counts it,** so the folder above can be shared, and so can the folder itself again, later, as a new share with new keys and a new ID.
- **The app that ended it remembers,** in its **No going back** mark for the share (protocol section 6.8), stored as 2^53 − 1, above every key version, so older apps keep it and refuse it as they refuse any version below a mark. While it keeps the mark, it never writes under the share or seals it to an agent again, even if a server lists it again (Decide, item 5).
- **Nothing in the tree moves,** and no page changes: their versions, heads, history and addresses stay as they are.

It is one step, and it can't be undone. Sharing again is a new share, which shares the history again (protocol section 6.7).

### 2. Rewrapped into the owner region, not kept under the old keys

Every retained record wrapped under the share's keys gets one v2 envelope for each owner, sealed by the owner ending it, and loses its wrap. The content keys don't change, so nothing is encrypted again and attachments are untouched (their AD names no share, protocol section 5.3).

The other way was to retire the share in place: rotate it to a key version only the owners hold, and keep it as a share with no members. That is cheap, one rotation, but the folder stays a share root, so the folder above still can't be shared. Allowing a retired share inside another would put a folder only the owners can read beneath a shared one, which `wikistow.md` rules out ("a private child cannot live beneath a shared folder"), and the region rules and the interface would have to tell retired shares from live ones for good.

### 3. Who can do it

The space's owners, as people with a session, as for every other sharing action. Agents can't (protocol section 9.5). A share whose root is in the trash can't be ended: its owner restores it first, or deletes it for good, which ends it anyway.

### 4. How it is sent

The owner's app does what a move into the owner region does, without moving anything:

1. **Preview.** It works out who loses access as a move's preview does (protocol section 10): the people holding the share's current keys, from the envelopes it verifies, and the members the server lists, but the owners; the groups that have the folder; and the agents with a pick or a group there, by the names the server lists. It adds what ends with it and what stays, from a new owner-only route, `GET /api/shares/:shareId/ending`, since no listing says who turned a link on: the pages with a public link that ends or that stays (decision 6), and the pages with a live publication into another space, or that are one from another space. Nothing is sealed before the owner confirms.
2. **Scan.** It lists every record wrapped under the share, by key material, with a new scope of the scan route (`share`): the pages and folder names under the root, the space's name for a space share, and the records of what is in the trash under it (decision 8), but a copy's hidden nodes'. For each, it opens the content key through the wrap, checks it against the record, and seals it to every sealing owner (protocol section 6.5) in a v2 envelope. Ending writes nothing under the share's keys, so any key version it can open will do, including one that counts only for reading.
3. **Upload.** `POST /api/shares/:shareId/end {permissionVersion, keyEnvelopes, metadataEnvelopes}`, with the permission version of the share's root (the space's, for a space share). A request sent again after a lost answer finds the share gone (`not-found`); once the server no longer lists the share, the app counts that as done, and sets its mark. A server that claims so falsely only keeps that app from writing under a share that still exists. Under the lock on the space, which every write also takes, the server finds the share again, so a request that waited behind one that ended it gets `not-found`, and checks the caller is an owner and the permission version is current, and that the envelopes cover exactly the records wrapped under the share, but a copy's hidden nodes', each going to exactly the space's current owners, signed by the caller. A record not covered, saved since the scan, is `stale-head`, and so is an envelope for a record no longer wrapped under the share, gone since the scan (a trash sweep, draft retention) or moved out of it: the app scans again, drops what the scan no longer lists, seals what it lacks and sends again. In the same transaction it deletes the share with everything that cascades from it, stores the envelopes, then ends what decision 6 ends, judging publish rights after the deletion as a rotation does, bumps the permission versions of the space and of every node under the root, records `share.ended` in the audit log, and tells the live tree.

A change of access meanwhile, a member added, a rotation, or a co-owner added or removed, moves the root's permission version on, so the ending is refused as `permission-version` and previewed again. The envelope check still refuses envelopes to anyone but the current owners (`recipients-mismatch`). A record the owner's app can't open, such as one an editor wrote with a wrap that fails `key-commitment`, stops the ending, naming its page or folder, as it stops making a share. The owner deletes that page or folder for good to get past it.

**Cost, measured.** A throwaway variant of the sharing-cost benchmark (`apps/server/bench/sharing-cost.ts`) timed exactly this rewrap, as a move of a folder out of a shared folder to the top of its space, through the real client operation and server, on the benchmark's host. Each page had 20 versions of about 2 KB, and the host (8 threads available to the run) was shared with other work, at a load average between 4 and 75, so the times are an upper bound; the sizes don't depend on it.

| Records | Owners | Time | Request | Per record |
|---|---|---|---|---|
| 8,001 | 1 | 10.3 s | 3.2 MB | 1.3 ms |
| 8,001 | 2 | 21.6 s | 6.4 MB | 2.7 ms |
| 8,001 | 3 | 25.7 s | 9.5 MB | 3.2 ms |
| 40,001 | 1 | 102 s | 15.9 MB | 2.5 ms |
| 40,001 | 2 | 164 s | 31.8 MB | 4.1 ms |
| 40,001 | 3 | 149 s | 47.6 MB | 3.7 ms |

Each owner adds 397 bytes of JSON a record, an envelope with its signature, against about 260 for a wrap when making a share. Ending a share of 8,000 records, a whole space of the benchmark's family library, takes 10 to 26 seconds with one to three owners, about as long as making that share took (13.5 s).

### 5. Members, groups, agents and the people who wait

- **Members** lose access at once, as if each were removed (protocol section 7.5), but nothing rotates: there is no share left to rotate. They keep every key version they held (A3).
- **Groups** lose the folder. A group's own name and members don't change, and its other folders keep their access.
- **Agents** lose their picks and group access there, as when their person loses access (section 9.4). They keep the keys they held (A6). An owner's own agent with a pick in the folder loses it too; its person picks the folder again, which makes it a new share (section 9.4), or picks the folder above once that is shared. A person's contacts record keeps the ended share in its agent's `shares` list, which then costs nothing: the server lists no grant there, and the app seals only shares the server lists as missing.
- **People waiting** for the share's keys (section 7.9) stop waiting.

### 6. Publications and public links

- **Public links** follow ADR 0005, decision 8: a member who turned a link on can no longer publish the page, so the link ends, with its copies; a copy a member uploaded of a page whose link an owner turned on goes, and that public page says it is being updated until an owner updates it. Links owners turned on stay, and so do later publishes through them: a former member who kept such a link can read what the owners publish on that page afterwards (A12). The preview lists the links that end and those that stay.
- **Publications into other spaces** from pages in the folder stay live, and their copies don't change. Only someone who can publish the source page sends a new version or ends one (protocol section 13), which is now only the owners. The preview says so.
- **Publications into the folder** from other spaces stay too. Their destination pages are now in the owner region, so a source publisher who isn't an owner here can no longer send to them; their app lists the publication by its space alone, and they can still end it, as for any copy they can't publish at. The owners keep the pages, or detach them.

### 7. Writers who haven't heard

No new check is needed. Each case meets one that exists:
- **A write prepared before the ending** names an older permission version, and is refused (`permission-version`).
- **A former member, or their agent,** has no access: `not-found`, or `forbidden` for a page they could still name.
- **An owner's app** that still holds a version opened through the share's wrap sends a wrap for a page now in the owner region, which the server refuses (`region-mismatch`, section 6.8). A draft save opens its base again, finds it sealed to the owners, and writes there (`saveDraft` already retries this way); any other write gives the error it gives after a move today, and the person tries again. The app that ended the share refuses before sending, through its mark.
- **A write the ending races** waits for the space lock. One that landed before it, after the app's scan, makes the ending `stale-head` instead (decision 4).
- **Offline changes** (ADR 0009): an owner's drafts are sealed when sent, with the keys of that moment, so they go to the owner region. A folder rename queued before the ending keeps the region it was queued in and stays refused, as after a move today (#359); nothing goes under the old keys. A former member's changes come back as a page out of reach, with **Save as a new page in my space**, **Copy text** and **Discard**.
- **Kept pages** on a former member's device are dropped once it is online again, as after any removal (A13).
- **Unfinished copies** into the folder fail at their finish, as for a share made at the destination (protocol section 10). A move out of it, opened before, fails as its source's permission version moved on; a copy out of it by a former member fails its finish's check of who may copy.

### 8. The trash

What was deleted from under the share keeps its wraps today, and restoring checks they fit where it goes. Ending the share would leave those records with no keys at all, since the wraps cascade with the share, so a restore would fail for good. So the ending seals them to the owners too: the scan goes by key material, which covers them, as the owner-region scan covers the trash for a new co-owner. They then restore into the owner region like anything else. Only owners see the trash, so this tells nobody anything.

Making a share leaves the trash as it is, as today. So once the owner shares the folder above, what was deleted from under the ended share is sealed to the owners under a folder of the new share, and restoring it is `region-mismatch` (protocol section 10, **The trash**). The confirm step says to restore anything wanted back before sharing the folder above.

### 9. Sending in parts (#328): not now

One request holds tens of thousands of records (decision 4): at 397 bytes a record for each owner, 64 MiB holds about 169,000 with one owner, 84,000 with two and 56,000 with three. Making a share fits about 250,000 (`wikistow/benchmarks/sharing.md`), and a family library's spaces hold about 8,000 each. So #328 stays a written-down limit, and the dialog says the folder is too large to end at once when the server answers `payload-too-large`. These counts come from the body limit alone: the benchmark ran in process, so it never met the server's 60-second idle timeout on a socket (`apps/server/src/main.ts`), which a request whose transaction runs longer could reach first. Building the ending checks that on the largest request it allows. **Checked (2026-11-09):** a share of 160,002 records with one owner, a 63.5 MB request, took the server 58.5 seconds in process, on a host at a load average between 26 and 59, so on a socket its answer may be lost near the limit. The transaction still finishes, and the app's request sent again finds the share gone (decision 4), so the ending holds; a quieter host has room to spare.

When someone gets near it, #328 builds one mechanism for every request that carries key material for a whole subtree (making a share, a move across a region, ending a share, adding a co-owner), on the pattern of a copy's three steps (ADR 0007, decision 7):
- **Open** names the operation and the permission versions it was prepared at, and changes nothing.
- **Parts** carry key material in batches, staged apart from every read; a record sent again replaces what was staged for it.
- **Finish** runs today's checks against everything staged, under today's locks, in one transaction. A record saved meanwhile is `stale-head`, naming what is missing, and the app sends it in another part and finishes again. `permission-version`, `key-version` or `recipients-mismatch` deletes the operation, and the app starts again from a new preview.
- Staged material is deleted a day after its last request, or at once on Cancel. The dialog shows how much is sent, with **Cancel**.

Writes go on meanwhile, as they do while the app scans today; the finish's coverage check catches them. Wraps staged under a destination share's keys sit on the server until the finish, which A10 already accepts for a move. Ending a share stages only envelopes to the owners.

### 10. Where it shows

- **The Share dialog** of a shared folder or the shared space has **Stop sharing** (**Stop sharing space**) under its access list, for owners. It opens a confirm step, "Stop sharing *Folder*?", with **These people lose access** (people, groups, and agents "via" their person), **Public links that end**, **Public links that stay**, **Publications only owners can send from now on**, and a note: "They keep what they already read or downloaded. Nothing saved from now on reaches them, except through a public link that stays or a publication they can read elsewhere." When the trash holds anything from the folder, it adds that restoring it is easiest before sharing the folder above. Then **Cancel** and **Stop sharing**, which shows how many versions are done for a large folder.
- **Sharing a folder that holds a share,** or sits inside one, names that share, and for owners offers **Open its sharing**, where **Stop sharing** is, in place of today's plain "shares don't nest".
- **Members and owners** lists each shared folder with the same **Stop sharing** in its menu.
- **The CLI** has none: agents can't share.

### Out of scope

Ending a share by folding it into a share of the folder above, in one rewrap, with its members carried over (see Considered options). A share rooted in the trash. Sending in parts (#328, decision 9).

## Threat model

Ending only narrows who can read: content moves from a share's audience to the owners, who already hold every key of every share in the space. So it gives no new reader a key, and a server can't use it to add one. The owners it seals to are the app's sealing owners (section 6.5), so an owner another owner removed, whom this app still accepts, is sealed to as by any owner-region save from that app (A5), and so is an identity a server got accepted as an owner at first sight (A4). Both already read the owner region; ending gives them the share's history as a move out of it would.

- **What former members keep** is what anyone removed keeps (A3): every key version they held, and so every record wrapped under them. The rewrap keeps the content keys, so a server that kept the old wraps can serve those records to them. Nothing saved after the ending is under a key they hold.
- **A server that undoes or hides an ending** is A2. One that keeps serving the share, its wraps and its current key version to an owner's app that hasn't heard, and accepts writes under it, makes those writes readable to former members who collude with it, as a server that hides a removal can. The app that ended the share keeps it in its **No going back** mark (decision 1), so this works on any app but that one while it keeps the mark: another owner's, the ender's other devices, their agents, their other open browser tabs until those read the marks again, and the ender's own after its marks are lost (signing out, a browser whose site storage was cleared, a desktop without a trusted secret store, a restore notice), as for a hidden rotation. Most family spaces have one owner on two or more devices, so the mark narrows this risk without closing it.
- **A server that hides a record from the scan** can't keep it in the share without breaking its own check, and if it lies about that too, the record stays wrapped under the old share. If the server places that page outside the share from then on, the owner's app refuses its next save as `region-mismatch` (section 6.8), and the ender's app refuses any write under the share through its mark. Only a server that also keeps placing the page in the share gets another owner's app to write under the old keys: the rollback above.
- **A server that ends a share by itself** can stop serving it to members, which it can do anyway (A2), but can't make anyone's app seal content to people: the owner region's envelopes come only from owners' apps.
- **A malicious member** can block an ending by writing a version the owners' apps can't open (decision 4). That costs availability only, and the owner deletes the page or folder for good to get past it.

## Considered options

- **Retire the share in place**, owner-only, without a rewrap. Rejected in decision 2: the folder above still couldn't be shared.
- **Fold it into the folder above's new share** in one rewrap, straight from the old share's keys to the new share's, with the old members made members of the folder above. One rewrap instead of two, but it gives the old members the folder above without the owner choosing it, and joins two dialogs into one hard to follow. An owner can stop sharing and then share the folder above, which costs a second rewrap of the same records, a minute for a family's largest space.
- **Delete what's in the trash under the share** at the ending, instead of sealing it to the owners (decision 8). Simpler, but it deletes what someone may still want back.
- **Send it in parts now** (#328). Rejected in decision 9 until a library gets near the limit.

## Consequences

- `wikistow/protocol.md` gains section 6.9, **Ending a share**, and notes in sections 2.4 (A2), 5.5, 6.1, 6.8, 9.5, 10 (**The trash**, and its hidden nodes), 12.2 and Q8, marked accepted. `protocol-review.md` logs it. `wikistow.md`'s Sharing, `ui-design.md`'s Sharing and `CONTEXT.md`'s **Share** say an owner can stop sharing.
- The server gains `POST /api/shares/:shareId/end`, `GET /api/shares/:shareId/ending`, the scan route's `share` scope, and the audit action `share.ended`. No existing response gains a field: a listing just loses the share.
- The client gains an ending operation, built from the move's rewrapper and preview, and an ended value for a share's **No going back** mark, which writing, rotating, moving and sealing to agents at unlock all check.
- Older apps meet an ended share as a share they lost access to, or, for an owner, as content that moved into the owner region, which they already handle.

## Implementation, in pull requests

1. **This ADR, the spec and the protocol.**
2. **The server:** the routes, the scan scope, and the transaction, with integration tests for the checks, a stale writer, an owner's stale wrap, the trash and the content-leak sweep after an ending.
3. **The client operation and the dialog:** preview, scan, seal, send and retries, the Share dialog's **Stop sharing**, the pointer from a nested share and Members and owners, with an e2e test that stops sharing a folder and then shares the folder above.

Step 3 needs step 2.

## Decided (2026-11-09)

Scott accepted every recommendation below on 2026-11-09.


1. **Rewrap into the owner region, or retire the share in place?** Recommended: rewrap (decision 2). Retiring is cheaper but keeps the folder above from being shared, which is the point of #329.
2. **The space share too?** Recommended: yes, with the same steps and dialog. Its members then lose the whole space, and the space's name goes back to the owners.
3. **What's in the trash under the share: seal it to the owners, or delete it for good?** Recommended: seal it to the owners (decision 8), so it can still be restored.
4. **Publications into other spaces from the folder: keep them live, or end them with the share?** Recommended: keep them (decision 6). They are copies the readers there already have, and the owners can still update or end them.
5. **An "ended" mark on the device that ended a share,** so it never writes under that share again even if a server lists it again? Recommended: yes (decision 1). A removal leaves the remover's device a **No going back** mark at the new key version, and the owner who ends a share is the one most likely to keep editing the folder, so the ending gets the same protection, in the same mark. It protects that device only, while it keeps its marks; the owner's other devices, their agents and other owners' apps learn of it only from the server, as of a rotation (A2).
6. **Send large shares, moves and endings in parts now (#328)?** Recommended: no (decision 9). Keep #328 open as the written-down limit, and build it, for all four requests at once, when a library gets near it.
7. **Where Stop sharing shows.** Recommended: the Share dialog, the pointer from a nested share, and Members and owners (decision 10).
