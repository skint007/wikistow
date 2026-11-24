---
status: proposed
---

# Sending large shares and moves in parts

Four owner actions carry key material for every record of a subtree in one request: making a share (protocol section 6.7), a move across a region boundary (section 10), ending a share (section 6.9) and adding a co-owner (section 7.6). The server takes at most 64 MiB in that request, so a large enough folder can't be shared, moved across a share, unshared, or given a co-owner. It answers `payload-too-large`, and nothing changes (#328). ADR 0012 decided to leave that limit alone until a library gets near it, and then to build one mechanism for all four, on the pattern of a copy's three steps (ADR 0012, decision 9; Scott, 2026-11-09). This ADR designs that mechanism: an open operation that collects the key material in parts and commits it at once. It covers what readers and members see while the operation is open, how a failed or abandoned one is cleaned up, what happens to writes, moves and access changes made meanwhile, progress and Cancel, resuming, and limits. **It is low priority.** A family's space is about a thirtieth of the limit (decision 1).

In short:
- **Open, parts, finish.** The owner's app opens a **change in parts** (`POST /api/spaces/:spaceId/parts`), naming its kind and subject. It sends the per-record key material in parts of at most 8 MiB, each a request of its own. Then it sends today's request, with the per-record lists empty and the change's ID in their place. That request is the **finish**: today's checks, under today's locks, in one transaction.
- **All or nothing.** Parts are stored apart from every table a read uses. Nobody but the opener is told a change is open, and nothing a part carries reaches a reader or a member before the finish commits. A refused finish leaves the tree, the shares and the keys as they were.
- **What waits, and what goes in the finish.** Parts carry only what depends on each record: the wraps, or the envelopes to the owners or a new co-owner. Everything that depends on who can read goes in the finish: the permission versions, the new share's folder key envelopes, its members, groups and agents. So a change of access meanwhile costs a new preview and a new finish, not every part again. The app sends that part only after a **check** of the finish passes, and never hands a new share's keys, or a co-owner's statement, to someone it then leaves out.
- **Writes go on meanwhile.** A version saved in the subtree while parts are sent is caught by the finish's coverage check (`stale-head`). The app asks the scan route for just the records still missing (`missing=`), sends them in one more part, and finishes again. A removal or rotation never waits for an open change.
- **Cleanup.** **Cancel** deletes the change and its parts at once. A change nobody sent anything to for a day is swept, as unfinished copies are. Parts count toward a bound the server works out from the subtree, not toward storage.
- **Progress and Cancel** show in the dialog that started it: versions wrapped and versions sent, of how many.
- **Resuming** works within the running app: a lost part is sent again, and an offline device carries on when it is back, within the day. After the app closes, the change isn't resumed: the app cancels its own at the next unlock and says so (Decide 4).
- **Small changes stay as they are.** When everything fits in one part, the app sends today's one request. Older apps keep sending one request too, up to today's 64 MiB.

## What the code supports today

- **One request each, at most 64 MiB.** `BULK_BODY = 64 * 1024 * 1024` (`apps/server/src/routes/content.ts:185`) is the body limit of making a share (line 366), a move (line 390), ending a share (line 435) and adding an owner (line 649). Past it, `readLimited` (`apps/server/src/http/mount.ts:646`) answers `payload-too-large`, and the Share dialog says "This folder is too big to share in one go." (`packages/ui/src/sharing/messages.ts:21`, and `stop-sharing.tsx:33` for an ending).
- **Two clocks bind before 64 MiB on a slow link or a busy server.** A large body must arrive within 60 seconds (`LARGE_BODY_DEADLINE_MS`, `apps/server/src/config.ts:131`), which takes about 9 Mbit/s of upload for 64 MiB. Then the transaction runs with the socket quiet, and the server closes a socket idle for a minute (`IDLE_TIMEOUT_MS`, `apps/server/src/main.ts:26`, set at line 115). ADR 0012 measured an ending of 160,002 records, a 63.5 MB request, at 58.5 seconds in the server on a loaded host, so its answer may be lost near the limit (ADR 0012, decision 9).
- **The space is locked for the whole transaction.** `makeShare` (`packages/server/src/content/sharing.ts:542`) locks the space, checks nesting, the root's permission version and coverage (`requireCoverage`, line 783), then inserts every wrap in chunks and deletes the subtree's owner-region envelopes. `moveNode` (`packages/server/src/content/moves.ts:111`), `endShare` (`packages/server/src/content/ending.ts:62`) and `addOwner` (`packages/server/src/content/owners.ts:380`) do the same for their material. Every write in the space waits meanwhile. Owner envelopes' signatures are checked before the lock, 200 at a time (`verifyGrants`, `moves.ts:392`).
- **Large bodies take a slot.** Each account reads one large body at a time, and the server four in all, in the `bulk` pool (`BULK_PER_ACCOUNT`, `BULK_AT_ONCE`, `mount.ts:93`). Rotations and owner removals have a pool of their own, so a share being made never holds off a removal.
- **The app already scans in parts, and reports progress.** `forEachRecordKey` (`packages/client/src/operations/sharing.ts:231`) walks the scan route (`scanRecords`, `packages/server/src/content/sharing.ts:1401`) a page at a time and calls `onProgress` with records done of the total (`Progress`, `sharing.ts:161`). But `shareFolder` (line 549) keeps every wrap in one array and sends it in one `makeShare` call (line 692), so the whole request is in memory twice, as objects and as JSON.
- **Retries rescan everything.** A move refused as `stale-head` scans the whole subtree again and resends all of it, up to four times (`sendRewrapped`, `packages/client/src/operations/moves.ts:463`). An ending does the same (`packages/client/src/operations/ending.ts:242`).
- **Copies already go in parts.** A copy is opened (`openCopy`, `packages/server/src/content/copies.ts:250`), filled in batches of at most 8 MiB (`MAX_RECORDS_BODY`, `packages/contracts/src/routes/copies.ts:25`; `sendCopyRecords`, `copies.ts:497`), where a node's entry replaces what was sent for it, and finished under locks in one transaction (`finishCopy`, line 771). A finished copy is kept a day, so a finish sent again answers the same. An unfinished copy nobody sent to for a day is swept (`sweepCopies`, line 1210, from the hourly sweep in `packages/server/src/content/pages.ts:1453`). The copy dialog has Cancel (`packages/ui/src/page/confirm-copy.tsx:145`). Imports send batches of 8 MiB too (`packages/contracts/src/routes/imports.ts:21`).
- **Key material isn't charged.** An account's storage counts payloads, attachments, live sessions, its contacts record and public copies (`usedBytes`, `packages/server/src/content/quota.ts:72`), never wraps or envelopes.
- **Share changes are pending across tabs while they're sent.** `sendShareChange` (`packages/client/src/operations/share-changes.ts:31`) records a rotation, an ending or a move into or out of a share as pending, so no tab joins or sends in that share's live sessions until the answer (protocol section 6.8).

### How large a subtree fits today

From the sharing-cost benchmark (`apps/server/bench/sharing-cost.ts`, `wikistow/benchmarks/sharing.md`) and ADR 0012's measured rewrap: a wrap is about 262 bytes of JSON (2.1 MB for 8,009 records), and an envelope to an owner about 397 to 400 bytes (3.2 MB for 8,009 records, one envelope each). So one 64 MiB request holds:

| Request | Per record | Records in 64 MiB | Pages at 20 versions each |
|---|---|---|---|
| Make a share, or move into one | 262 B | about 256,000 | about 12,800 |
| End a share, or move out of one, 1 owner | 397 B | about 169,000 | about 8,400 |
| The same, 2 owners | 794 B | about 84,500 | about 4,200 |
| The same, 3 owners | 1,191 B | about 56,300 | about 2,800 |
| Add a co-owner (owner-region records) | 400 B | about 167,000 | about 8,400 |

The benchmark's family space, 400 pages of 20 versions (8,009 records), sends 2.1 MB to be shared, 3 % of the limit, and 6.4 MB to be ended with two owners, 10 %. The other clocks bind first: on a 5 Mbit/s upload only about 37 MB arrives within the 60-second deadline (about 143,000 wraps), and on 2 Mbit/s about 15 MB (about 19,000 records ended with two owners, some 950 pages). The client takes 1.3 to 2.5 ms a record to open, check and wrap (ADR 0012, decision 4), so a share of 256,000 records takes about 5 to 11 minutes before anything is sent, with no way to stop it.

## Decisions

### 1. One mechanism for the four requests, and when to build it

ADR 0012 settled that #328 builds one mechanism for every request carrying key material for a whole subtree: making a share, a move across a region, ending a share and adding a co-owner (Scott, 2026-11-09, ADR 0012 Decide 6). They differ only in what each record gets (a wrap under a share's key version, or a v2 envelope to each owner or to the new co-owner) and in the small part that depends on the audience. So one change in parts serves all four, with a `kind` of `share`, `move`, `end` or `co-owner`.

**When.** A family's space is 3 to 10 % of the limit, so nobody needs this yet. The recommendation is to accept the design now and build it when a library passes half the limit, or earlier if Scott wants the progress and Cancel for large shares on their own (Decide 1). Step 2 of the implementation adds a server log line, `bulk-request-large`, when a bulk request passes 32 MiB or its transaction 30 seconds, so the operator sees the limit coming. That line is cheap enough to add before the rest.

### 2. Open, parts, finish, through today's routes

Three ways to carry the material in parts were considered:
- **A. New routes for each kind** (`/shares/:id/parts`, `/nodes/:id/move/parts`, …). Four sets of open, part and cancel routes, with the checks of each repeated.
- **B. One change in parts, finished through today's routes.** Recommended. One open, part, cancel and list route for all four kinds. The finish is today's request for that kind, with `parts: partsId` and its per-record lists empty, so every check today's route makes stays in one place, and older apps keep sending the one request.
- **C. Stream one request.** Lifting the body limit and streaming the body into the transaction keeps one request, but keeps the space locked while it arrives, keeps every clock above, and gives nothing to resume from.

With B:
1. **Open** (`POST /api/spaces/:spaceId/parts {partsId, kind, subject}`), by an owner of the space as a person with a session, never an agent, as for the four actions today. `partsId` is made by the app with `newId`. The subject is, for `share`, the root (`rootId`, null for the space) and the new share's ID (`shareId`); for `move`, the node and its destination parent; for `end`, the share; for `co-owner`, the identity being added and its key version. The server checks what it can check early, as the finish will again: the caller is an owner; the share ID is unused, and from then on it counts as used; the nesting rule; the move crosses a region boundary. It records the subject's region and, into a share, the share. It changes nothing else, and takes no permission version: everything that depends on access is checked at the finish.
2. **Parts** (`POST /api/parts/:partsId {wraps, keyEnvelopes, metadataEnvelopes, commentEnvelopes}`), by the opener only, each at most 8 MiB (decision 8). The server checks each entry as it checks today's request, without the space lock: it names a record stored in the space and in the change's scope now (`binding-mismatch` for one never stored, `stale-head` for one gone since); a wrap is under the change's share and that share's current key version (`key-version` naming it otherwise); an envelope's signature verifies, by the opener at their current key, and it goes to a current owner, or for `co-owner` to the identity being added (`recipients-mismatch`). It stores them **staged**, one row per record, or per record and recipient for envelopes. A record sent again replaces what was staged for it. A part is refused whole, staging nothing, and a refused part leaves the change open. Its answer names the entries at fault: the app drops those for records gone since, and for the rest acts as for the same refusal at the finish (decision 6), working out the preview, the recipients or the key version again rather than sending the same bytes. Parts, `missing=` and the finish judge an entry by the same rules. The answer gives how many records of the scope have their material so far, and of how many. Parts, `missing=`, the check, the finish and Cancel all need the opener to be an owner still, at the key version they opened at; removing an owner, or a change of their key, deletes their open changes.
3. **Check, then finish.** First the app sends the finish with `check: true` and without the sealed part of the audience (a new share's folder key envelopes; a co-owner's folder key envelopes and owner statement). The server runs every check the finish runs that doesn't need them, under the same locks, answers as the finish would, and commits nothing. Only once a check passes does the app send the finish itself, at once. So the sealed audience part leaves the device only when the finish is all but certain; a version saved in the second between is the one way it can still be refused (decision 6).

   The **finish** is today's route for the kind (`makeShare`, `move`, `end`, `addOwner`), with `parts: partsId` and empty per-record lists. The route runs every check it runs today, under the same locks, reading the per-record material from the staged rows in place of the body; `makeShare`'s check that the share ID is unused accepts the ID this change reserved, and only that one. A finish (or check) may also carry a last small batch of per-record material inline, the catch-up for records saved since the last part, so catching up and finishing are one request. Then it moves the staged rows into the live tables with set-based statements, marks the change finished, deletes its rows, and does everything else it does today in the same transaction: bumping permission versions, ending live sessions (`loseLiveKeys`), ending lapsed public links, the audit log, telling the live tree.
   **Locks.** The change's row is locked by every request that reads or writes its staged rows: a part, the check, the finish, Cancel and the sweep. The finish takes today's locks first (the account's writer queue where today's route takes it, then the space, as today), then the change's row, then the share and subtree locks it takes today. A part, Cancel and the sweep take the change's row alone, never the space while holding it, so no request waits on a lock held by one waiting on it. So a part can't change what a finish has checked, and a cancel can't delete rows a finish is copying.

   **A finish sent again** after its answer was lost, and a check, find the change by `partsId` first, for its opener, before any check that needs the subject to exist: a finished change answers as its finish did. So an ending whose share is gone answers as it did, not `not-found`.
4. **Cancel** (`DELETE /api/parts/:partsId`), by the opener, deletes the change and its staged rows at once. A cancel of a change that finished answers as the finish did and keeps the record of it; a cancel of an open one deletes it, so a finish still on its way finds no change (`not-found`) and can't commit. That makes Cancel the app's way to settle a finish whose answer was lost (decision 10). **List** (`GET /api/parts`) gives the caller's open changes: ID, kind, space, subject, when opened and last sent to, and how many records have material. It names nothing the caller couldn't already see.
5. **The scan route** gains `missing=partsId`: in the change's scope, only the records whose staged material is incomplete. For envelopes that means one missing for any current owner, or for the co-owner. It lists them as the scan lists records today, in parts, with the same key material, so the app opens them as it does now.

The finish holds the space lock only to check and to copy rows the database already has. Today the lock also covers parsing and inserting the whole body. The finish of 256,000 staged wraps is expected to take seconds, not a minute; step 2 measures it.

### 3. All or nothing

- **Nothing is visible until the finish commits.** Staged rows are in tables of their own (`staged_changes`, `staged_material`), which no tree, page, scan (but `missing=`), envelope or search route reads. The tree, the shares, the members and every record's key material stay as they were until the finish's transaction commits. If it fails, nothing changes, as today.
- **No new nodes are made**, unlike a copy, so nothing is hidden or needs to be. The new share's ID is reserved, but no share row exists until the finish.
- **Only the opener learns that a change is open.** Members, other owners and agents are told nothing. The other owners' apps see the subject's permission versions move on only when the finish commits.
- **Material only the finish can use.** For a new share, the parts carry wraps under version 1, whose folder keys go to nobody until the finish brings the envelopes. For an ending, a move out of a share and a co-owner, they carry envelopes to owners or to the new co-owner. Only for a move into a share do the parts carry something a member could open: wraps under that share's current keys, which A10 already accepts once the owner has pressed Move (Threat model).

### 4. What the parts carry, and what the finish carries

A part carries only what depends on one record and the change's subject:

| Kind | Each record gets, in the parts | The finish carries, as today |
|---|---|---|
| `share` | a wrap under version 1 of the new share | the share's ID and root, version 1's folder key envelopes, members, groups, agent grants, the root's permission version |
| `move` into a share | a wrap under the destination share's current key version | the destination parent, the expected old parent, both permission versions, the position |
| `move` out of a share, `end` | a v2 envelope to each current owner | the permission versions (and for a move the parent and position) |
| `co-owner` | a v2 envelope to the new co-owner, for each owner-region record | the folder key envelopes of every share version to them, the owner statement, the permission version |

Folder key envelopes are one per person or agent and key version, a few kilobytes for a family, so they always fit in the finish. That split is what decision 5 rests on: nothing staged says who can read.

### 5. Writes, moves and access changes while a change is open

Parts can take minutes, and the space is not locked meanwhile, so people keep working. A removal or a rotation never waits for an open change. The finish's checks decide, under the space lock, as they do today for the seconds between the scan and the request:

| Meanwhile, in the subtree or its share | At the finish | Then the app |
|---|---|---|
| A version saved, a page or folder made, a comment written, a node restored from the trash into the subtree | `stale-head`, naming the pages and folders whose records lack material | fetches only those (`missing=`), and finishes again with them as the inline catch-up. A comment listed alone counts as on its page when that page is in the preview or in an earlier part: the scan's check that a comment's page is in the same scan reads the change's records, not one batch |
| A page or folder moved into the subtree, or made there, that the owner wasn't shown | `stale-head`, as above | for `share` and `move`, previews again from a fresh tree, keeping the staged rows, and asks the owner, as a move asks today (`previewAgain`), before it wraps anything for that node, in a part or a catch-up (the app checks every record it wraps against the preview, as `rewrapper` does today); a node whose parents don't lead to the subject in that tree is `binding-mismatch` (Decide 3). For `end` and `co-owner`, which go by key material and give no one new a key, seals it |
| The subject itself moved within its region (an editor moving the folder being moved out of their share) | `stale-head`, naming its new parent | previews again, keeping the staged rows, and finishes with the new expected parent |
| A draft checkpoint removed by retention, a node deleted for good or moved out, a comment deleted | its staged rows are ignored and deleted, never stored | nothing: they cover nothing any more (today this is `stale-head`) |
| A node moved to the trash | as moved out: the trash counts for no share's or move's coverage | nothing; for `end`, which covers the trash by key material, it stays covered |
| A member, role, group or agent change in a share the change touches, a co-owner added or removed, or the root moved | `permission-version` | previews again; keeps the staged rows; finishes with the new permission versions and the newly sealed audience part (decision 6) |
| A rotation of the destination share (`move` into it) | `key-version` | wraps everything again under the new version, as parts that replace the old ones |
| A co-owner added or removed (`end`, `move` out, `co-owner`) | `permission-version`; the finish then also needs an envelope to every current owner | seals to a new owner what `missing=` lists; staged envelopes to someone no longer an owner are never stored |
| The subject's region changed: the destination parent shared or its share ended, the share ended by someone else, the subtree now holding a share root | the error today's route gives (`region-mismatch`, `share-nesting`, `not-found`), and the change is deleted | starts again from a new preview |
| Another change in parts over the same subtree, by another owner or another tab, finished first | as for the row it falls under: its finish moved permission versions on, so usually `permission-version`, or `region-mismatch` | as that row says |

**Live sessions** in the subtree go on until the finish, which ends them as today (protocol section 5.10). The app records the share change as pending (section 6.8) only around the finish, not while parts are sent, so editing in the share doesn't stop for the minutes the parts take. But the checks the app makes today before its one request it makes **before every part**, and before every `missing=` batch it wraps or seals: it reads its **No going back** marks again and runs `requireCurrentPlan`, as `moveNode` does before each try today, and it reads its contacts record again and works out the sealing owners afresh. It never sends a wrap under a version below its mark, or an envelope to someone who isn't a sealing owner now. When another tab says it raised a mark for the destination share, the app stops sending at once, and wraps again under the new version. A server that accepted parts under a version below the app's mark is reported, as `key-version` is today (section 6.8).

**Offline changes** (ADR 0009) are sent, sealed for the region of that moment, as today. One that lands before the finish is a version saved meanwhile. One that lands after it was prepared before, and is refused with `permission-version` or `region-mismatch` and sealed again, as after any move.

**Agents** write meanwhile as anyone does. Their writes are versions saved meanwhile.

**Converging.** A page someone is typing into autosaves about once a second, so a finish can miss a version every time. Today the window is a whole rescan and resend; with `missing=` and the inline catch-up it is one short scan and the finish, under a second. The app tries five times, as moves try today, and then names the page that keeps changing, from the finish's answer, says to close it where it is open, and offers **Try again**. Holding writes in the subtree for the last catch-up was considered and left out: it would refuse autosaves, agents and offline changes, which then have to retry anyway (Considered options).

### 6. Permission versions and key versions at the finish

Today a refused request is thrown away whole, and the app previews and sends everything again. With parts, the finish is refused for the same reasons, but what was staged is kept unless it can't be right any more:
- **A refusal of the audience part keeps the staged rows**: `permission-version`, `recipients-mismatch`, and a member, group or agent the finish names that the server no longer takes (its answer names which), as well as the app's own refusals before it sends, such as an invitee's key change. The rows depend on no one's access: a wrap depends only on its record and the share's key version, which the finish checks; an envelope on its record and recipient, which the finish checks against the current owners. The audience part, which does depend on access, comes fresh with the next check and finish, from a new preview, at the permission versions that preview read. The app asks the owner again if what its dialog said would change: a person, group or agent who would now be left out or added, a person whose key changed, and for `co-owner` after any `permission-version`, since another owner may have just taken the person being added out of the space (Decide 2).
- **`key-version`** keeps the change and the rows, but the finish refuses while any staged wrap is under an older version, and `missing=` lists those records. The app wraps again, under the new version, every record it staged under an older one, from its own list rather than the server's; each replaces the old row.
- **`stale-head`** keeps everything (decision 5).
- **A refusal of the subject** (`region-mismatch`, `share-nesting`, `forbidden`, or `not-found` for the subject) deletes the change, and the app starts again from a new preview, as a copy does.

**Once the sealed audience part has left the device**, the app counts everyone it was sealed to as holding it, whatever the answer, since a server may keep a refused finish. For `share`, a later finish of the same change reuses version 1 only if it seals to all of them, at the same keys; otherwise the app cancels the change and starts a new share, with a new share ID, new keys and every part again. That needs an audience to shrink in the second between a passing check and the finish, so it is rare. For `co-owner`, a change cancelled or deleted after its statement left the device puts the person on the app's removed-owners list for the space (section 6.5), so it never seals to them or writes under a version they sealed, even if a server lists them as an owner; adding them again takes them off, as today.

### 7. Cleanup: Cancel, expiry and storage

- **Cancel** in the dialog stops the app after the part in flight and sends `DELETE /api/parts/:partsId`. Once the finish is sent, Cancel is gone: the dialog says "Finishing…". A cancel after a refused finish whose sealed audience part left the device doesn't say "Nothing changed": it says the folder wasn't shared (or the person wasn't added), and that a server which kept the refused request could still give the people it named this folder's versions as they were then (A10).
- **The co-owner's contacts write.** Today the adder's app records the person as accepted before the upload. With parts it does so just before the first finish, after the check passes, and undoes it, restoring their place on the removed-owners list if they were there, when the change is cancelled, expires or is deleted before any finish left the device.
- **Expiry.** A change nobody sent a part, a scan with `missing=` or a finish to for a day is deleted with its rows by the hourly sweep, as an unfinished copy is (Decide 5). A finished change is kept a day without its rows, so a finish sent again after its answer was lost answers as the first did.
- **Deleting the space, or the subject** (the root or node deleted for good, the share's root deleted for good) deletes the change with it.
- **Storage.** Staged material isn't charged to the account, as no key material is today (decision 8 bounds it instead). It is a few hundred bytes a record, and goes within a day.
- **A change cancelled while offline** is swept a day later. The app removes it at its next unlock, from `GET /api/parts` (decision 10).

### 8. Limits per account

- **Two open changes per account.** A third open is refused as `rate-limited`, naming none. Two lets one owner share one folder while ending the share of another, and stops a looping app from piling up changes.
- **Parts of at most 8 MiB**, as a copy's records and an import's batches, in a pool of their own (`parts`), one at a time per account and four in all. So a long change never holds off a small share made in one request (`bulk`) or a removal (`rotation`), and an 8 MiB part arrives within the 60-second deadline above about 1.1 Mbit/s.
- **A bound from the subtree.** A part may name only records in the change's scope now, one row per record (and per recipient for envelopes) that a resend replaces. A staged row goes with its record when the record is deleted, and each part first deletes the change's rows for records that have left its scope and envelopes to people no longer owners. A part that would take the change past its scope's records times its recipients, at the largest size an entry can be, is refused (`payload-too-large`). So a change never holds much more than its subtree needs, whatever an app sends.
- **The two-open limit** is counted under a lock on the account, as the item limits are (`requireCapacity`), so two opens at once in different spaces can't both pass it.
- **The write rate limit** (120 a minute) covers parts and finishes. At 8 MiB a part, a 256,000-record share is eight parts.

### 9. Progress and Cancel in the dialog

The app wraps one part's worth of records, sends it, and wraps the next while that part is on its way. So memory holds about two parts, not the whole request. The dialog that started the action (Share, **Move to…** or the notice after a drop, **Stop sharing**, **Add co-owner**) shows one line while it runs, "Sharing *Folder*: 120,000 of 256,000 versions", counting a version once it is sent, with **Cancel**. Before that, while the app works out the preview and opens the change, it shows the progress it shows today. After a cancel it says "Nothing changed." The dialog can't be closed by Escape or a click outside while parts are sent, only by Cancel, so nobody leaves a change running without seeing it.

Changes that fit in one part show no extra line: they go as one request, as today.

### 10. Resuming

- **A part that fails** for a network error or `rate-limited` is sent again with backoff. Resending replaces, so it is safe after a lost answer.
- **Offline** (the app knows from ADR 0009's checks), the dialog says "Waiting for the connection…" and carries on when the app is back online. A day's expiry gives room for a laptop closed overnight. A change that expired meanwhile answers `not-found`: the app says the share, move or ending stopped, and nothing changed.
- **Within the same app, no rescan is needed after a lost answer:** the app knows which records it sent, and the finish's `stale-head` and `missing=` find any gap.
- **A finish whose answer was lost** is settled through the change, not by guessing from the shares. The pending share change (section 6.8) records the change's ID. The app sends the finish again; if that fails too, it sends Cancel, which answers "finished" if the finish committed and otherwise deletes the change, so a finish still waiting for the space lock can't commit later. On "finished" it raises its marks (`ENDED` for an ending) before it clears the pending change, so no tab sends in the share's live sessions in between. Today a lost answer is settled by fetching the shares, which can't tell a request still waiting for the lock from one that failed.
- **After the app closes**, a reload or a crash, the change is not resumed (Decide 4). The app holds the preview, the change's subject and, for a new share, its folder keys only in memory, and the owner should confirm what is shared again anyway. At the next unlock the app lists its open changes (`GET /api/parts`) and cancels only those it recorded as its own, in its kept marks, that no running tab of it holds (tabs say so through the lock they share for marks), saying "Sharing *Folder* stopped when the app closed. Nothing changed." A change another device or a running tab opened is left alone; another device's shows in the owner's sharing settings with **Cancel**, and expires within the day. The other way, resuming after a restart, would keep the preview and keys on the device, sealed as kept pages are (A13), and stage the new share's version 1 envelope to the opener at the open so its keys could be recovered. It is more to build and test for something a person can redo.
- **Another device** of the same person sees the change in `GET /api/parts` and can cancel it, by hand, not continue it.

### 11. When the app sends in parts, and older apps and servers

- The app sends **one request, as today, when the material fits in one part** (8 MiB, about 32,000 wraps or 21,000 one-owner envelopes), and parts only beyond. Nearly every family action stays exactly as it is, and works against a server without parts.
- **Older apps** keep sending one request up to 64 MiB. The server keeps that limit for them.
- **A newer app against a server without parts** gets `not-found` for the open, and sends one request, which fails as today past 64 MiB.
- The CLI has none of the four actions (agents can't share or move across regions), so it doesn't change.

### Out of scope

Sealing parts under a key sent only at the finish (Decide 7). Resuming after the app closes (Decide 4). Making the per-record material smaller, such as a binary encoding of wraps. Lifting the account content limits (`DEFAULT_CONTENT_LIMITS`, `packages/server/src/content/limits.ts:7`).

## Threat model

Parts change when material reaches the server and how long it waits there, not what it is: the same wraps and envelopes, checked by the same rules at the finish. So the guarantees of section 2.3 hold as today. What is new:

- **A cancelled or abandoned move into a share.** The parts already sent hold wraps under the destination share's current keys. A server that keeps them can give them to that share's members, who open those records, and can then serve a tree that puts the pages in that share with those wraps, so the owner's next saves there go under its keys (A2). A10 already accepts this for a move once the owner presses Move, "even if the move then fails"; parts add a Cancel after some of it went up. A10 is widened to say so (protocol section 2.4). The gainers are the people the owner chose to move it to moments before.
- **A cancelled co-owner.** The parts hold envelopes to the person being added for owner-region records. A server that keeps them can give that person those records, as it could with today's one request if it then refused it. A10 is widened to cover it. The owner chose that person. The adder's app accepts them as an owner only just before the finish, and undoes that on a cancel (decision 7).
- **A cancelled share or ending, before any finish,** leaks nothing: a new share's wraps open only with folder keys whose envelopes come with the finish, and an ending's envelopes go to the owners, who hold everything already.
- **A refused finish.** A server that keeps a refused finish holds what today's refused request gives it: for `share`, version 1's envelopes beside the staged wraps, so it can give the people named the folder's versions as they were; for `co-owner`, the statement, which can't be revoked (A5). The check before the finish makes that rare, and the app never reuses version 1 for a smaller audience, and puts a co-owner it cancelled on its removed-owners list (decision 6). A10 is widened to say so.
- **A server that finishes a change by itself** can't before the finish's audience part has been sent: for `share` it lacks the envelopes, which the owner signs and sends only with the finish; for the others, a server that stores staged material in the live tables is a server misreporting key material and the tree, which it can do with any request (A1, A2).
- **A server hiding a rotation or an owner's removal from the app while parts go up** gets nothing more than with today's one request: the app checks its marks and its sealing owners before every part (decision 5), as it checks them before every request today.
- **A server that keeps a change open, or hides that it expired,** affects availability only.
- **A malicious member** can't open, send to or finish a change (owners only), or see one. By saving again and again in the subtree they can keep a finish from converging, as they can stop today's request with `stale-head`. The app's five tries end with a message naming the page; the owner can remove them.
- **Staged rows** are in the content-leak sweep (`apps/server/test/content-leak.integration.test.ts`): no route serves them to anyone but the opener, and only as counts.

## Considered options

- **Raise `BULK_BODY`**, and the deadlines with it. One line, but every clock above still binds, the space stays locked longer the larger the request, the server holds the whole body in memory twice, and there is still no progress for sending, no Cancel and no resume.
- **Split the action into smaller ones**, such as sharing a folder's subfolders one by one. Not all or nothing: members would see a half-made share, and shares don't nest, so it can't even be expressed.
- **Lock the subtree while a change is open, or hold writes for the last catch-up**, so nothing is saved there meanwhile. The finish would always converge, but autosaves, agents and offline changes would be refused for minutes, and a removal would wait.
- **Separate part routes for each kind** (decision 2, A).
- **Discard staged material on `permission-version`**, as today discards the request. Simpler to state, but a member added in a big share's minutes would cost every part again, and nothing staged depends on members (decision 6).
- **Seal parts under a key sent with the finish**, so the server can't use a cancelled change's material (Decide 7). It closes the two A10 cases above, but every check moves to the finish, which then verifies and parses everything under its deadline again.
- **Resume after a restart** (decision 10, Decide 4).

## Consequences

- `wikistow/protocol.md` gains **Sending in parts** at the end of section 6.7, marked proposed, with pointers from sections 6.9, 7.6 and 10, A10 widened, and Q8's answer changed. `protocol-review.md` logs its review round. `wikistow.md`'s follow-up points to this ADR.
- The server gains `POST /api/spaces/:spaceId/parts`, `POST /api/parts/:partsId`, `DELETE /api/parts/:partsId`, `GET /api/parts`, a `parts` field and `check: true` on the four bulk routes, `missing=` on the scan route, two tables, an hourly sweep, a `parts` body pool, the `bulk-request-large` log line, and the audit log's existing actions, with `parts: true` in their details.
- The client gains one sender shared by `shareFolder`, `moveNode`, `endShare` and `addCoOwner`: pipelined wrapping and sending, retries, Cancel through an `AbortSignal`, and the cleanup at unlock.
- No record, wrap or envelope format changes, and no domain string. Older apps and servers keep working as today.
- `wikistow/ui-design.md` gains the progress line and Cancel in the Share, Move, Stop sharing and co-owner dialogs.

## Implementation, in pull requests

1. **This ADR and the protocol** (proposed): `protocol.md` section 6.7 **Sending in parts**, A10, Q8, and one review round in `protocol-review.md` (#328).
2. **The server** (#328): the tables, the routes, the finish through the four routes, `missing=`, the sweep, the pool and the log line. Integration tests: nothing staged reaches a member, an agent or another owner (the content-leak sweep); each row of decision 5's table; a finish sent again; Cancel; expiry; the scope bound; two changes over one subtree. A variant of the sharing-cost benchmark times a finish of 256,000 staged wraps and reports it in `wikistow/benchmarks/sharing.md`.
3. **The client and the dialogs** (#328): the shared sender, the four operations on it, the progress line and Cancel, the cleanup at unlock, and an e2e test that shares a folder in parts with a part size lowered for the test, saves a page meanwhile, and cancels another.

Step 3 needs step 2. Step 2 needs this ADR accepted and its review round to meet the stopping rule.

## Decide

Questions only Scott can answer, each with a recommendation.

1. **Build it now, or when a library gets near the limit?** Recommended: accept the design now and build it when a library passes half the limit (decision 1). Add the server's `bulk-request-large` log line first, so the operator sees it coming. A family's space is 3 to 10 % of the limit today.
2. **Keep what was sent when access changes meanwhile, and finish after a new preview?** Recommended: yes (decision 6). Nothing staged depends on who can read, so a member added during a long share costs a new preview, not every part again. The app asks the owner again when what its dialog said would change, and for a co-owner always. A new share's keys are never reused for a smaller audience than one they were sent to.
3. **A page or folder that appears in a folder while it is being shared or moved: ask, or include it?** Recommended: ask, for a share and a move, as a move asks today when what moves changed. The app shows "These appeared while sharing" with each one's path, and **Share them too** and **Cancel**, neither the default; a move previews again. Endings and co-owners go by key material and give no one new a key, so they include it.
4. **Resume a change after the app closes?** Recommended: no (decision 10). Resume within the running app, offline included, for up to a day. After a reload or a crash, cancel it at the next unlock and say nothing changed. Resuming would keep the preview and the new share's keys on the device.
5. **How long an abandoned change waits before it is deleted?** Recommended: a day after its last request, as an unfinished copy (decision 7). Enough for a laptop closed overnight; short enough that little is kept.
6. **Limits per account: two open changes, and no storage charge for what is staged?** Recommended: yes (decision 8). Key material is never charged today, and the server bounds a change by its subtree.
7. **Seal parts under a key sent only with the finish, so a cancelled move or co-owner leaves nothing a server could use?** Recommended: no (Threat model). A10 already accepts that a move's wraps reach the server once the owner presses Move; widening it to a cancel after some parts went up is the same risk, towards people the owner chose. Sealing parts would move every check to the finish.
