---
status: proposed
---

# Editing a page together, live

Several people should be able to edit one page's draft at once, see each other's changes as they type, and none of them get a conflict (#321). Today a save names the draft it was based on. The server refuses a save whose base isn't the current draft head (`stale-head`), and the writer sorts out the conflict, now with **Merge…** (ADR 0013). This ADR decides how editors with a page's draft open edit one shared copy of it, end-to-end encrypted. It covers the merge model, how changes are sealed and relayed, how a newcomer catches up, how the shared copy becomes draft revisions, presence, what writers outside the session do, and what it costs on large pages.

In short:
- **Everyone with the draft open edits one copy.** An editor's app that opens a page's draft joins the page's **live session**. Each change goes out within about a tenth of a second and shows in the others' editors, in source mode and in the visual editor. Nobody in the session gets a conflict from anyone else in it.
- **A CRDT over the page's text (Yjs).** The session's shared document holds the page's title, front matter and body as text, and its files and extensions by key. Yjs merges changes made at the same time character by character, with no server that reads them. The source editor edits that text directly. The visual editor writes, and takes in, only the blocks a change touches.
- **Sealed like a comment for editors.** Starting a session makes a **session record**: a metadata record v2 with `subjectKind: "live"`, whose payload holds a fresh **session key**. In a share the record is wrapped with the share's draft key; outside shares it is sealed to the owners. Each change is encrypted with the session key and signed by its writer. The server relays ciphertext and keeps it only for a while. Readers never get the key.
- **Drafts stay as they are.** One app in the session, the **saver**, autosaves the shared document as ordinary draft revisions, signed by the saver, on today's autosave cadence. A revision's payload names the session and how much of it the revision holds, so every app knows when its own typing is saved. Publishing and the link table don't change. History adds who else wrote, and draft retention keeps the drafts a session needs while it lasts: the one it started from and the ones its snapshots name.
- **Writers outside the session keep the conflict.** The CLI and agents, offline changes, older apps and folder table cells save as today, and `stale-head` still guards them. When one of their saves lands, the saver folds it into the session with ADR 0013's merge. Where it overlaps what the session changed, the session's text stays and everyone in it is offered **Review**.
- **Presence** shows who else has the draft open, in the toolbar, and their cursors, sealed like the changes. The server sees who is in a session, when, and how much each person sends. It never sees what they send or where in the page.
- **A newcomer** opens the latest **snapshot**, which is the shared document as of a saved revision whose text it must equal, and then the changes after it.
- **A session ends** a minute after the last person leaves, once everything in it is saved, and at once when access to the page changes. The server then deletes it.

## What the code supports today

- **One writer at a time.** `saveDraft` (`packages/server/src/content/pages.ts`) locks the page's `page_heads` row. It refuses, as `stale-head`, a save whose signed `basedOn` isn't the draft head, with `detail: {draftHead, publishedHead}`. A publication must be based on the draft head too, under the same check.
- **The draft session.** `DraftSession` (`packages/ui/src/page/draft-session.ts`) holds the page being edited:
  - `#base`, the draft its next save builds on;
  - `#content`, the title, the Markdown with its front matter, and the attachments;
  - `#extensions`.

  Autosave (`autosave.ts`) saves one second after the last change, and at least every 10 s while typing goes on (`debounceMs: 1000, maxWaitMs: 10_000`), one save at a time. `noticeHead` raises the conflict when the page's head is one this session didn't make. The server's write limit, 120 a minute, is sized for autosave's one save a second.
- **The source editor** (`editor/source/codemirror.tsx`) holds the body, without the front matter, which the properties box edits (`PageEditor.changed` joins them). It hands the session the whole text on each change. It takes outside text through `replace`, as one span edit kept out of its undo history.
- **The visual editor** writes Markdown a block at a time (`visual/writer.ts`), caching a unit per top-level node.
  - Once the document differs from what it was given, it writes every block in its own style (`STRINGIFY` in `packages/ui/src/page/editor/visual/config.ts`; ADR 0013 decision 3).
  - Nothing maps a ProseMirror block to the source text it was read from.
  - New text goes in through `show`, after a fidelity check of the whole page. Measured in Chromium (spike below), the check takes 0.7 s at 60 KB, 1 s at 100 KB and 2.1 s at 200 KB, partly in the reader's worker, and `show` itself then blocks the page's thread for 160, 230 and 460 ms. Split mode paces this at `max(250 ms, 4 × the last one)`.
- **Other writers go straight to the server.** These are:
  - the chat assistant's approved proposals (`applyProposal`);
  - folder table cells (`setDraftProperty`);
  - changes made while reading (ADR 0008);
  - restoring a version;
  - a plugin's page edits for a page not open in this window;
  - the CLI;
  - the offline queue, when it sends.

  Edits a plugin makes through `PageHandle.editor`, and its edits of a page open in this window (`drafts.through`), go through the open editor.
- **Windows.** In the browser, tabs tell each other about the offline queue and about signing out, through `BroadcastChannel`s, never what was typed. The desktop app has one window.
- **Live channels.** `GET /api/me/tree-changes` and `/api/me/comment-changes` answer `application/x-ndjson`, one JSON line per change, with a blank line every 15 s (`apps/server/src/http/mount.ts`).
  - They are fed by Postgres `NOTIFY` and fanned out in memory in the one server process. They are for people only.
  - There is no WebSocket code or dependency, and the policy allows only `connect-src 'self'`.
  - The desktop app forwards `/api/*` from `app://wikistow` through its protocol handler, which streams responses but buffers request bodies.
- **Limits.** A page's Markdown is at most 256 KiB and its payload 512 KiB (`packages/contracts/src/routes/pages.ts`). A JSON request is at most 1 MiB.
- **No collaboration code.** No CRDT, operational-transform or collaboration library is in any package. `diff` 8.0.4 is in `packages/client`, used by the merge module (`pageMerge`).

## Decisions

### 1. Who joins, and when

- **Editors with the draft open.** Anyone who can edit the page (an editor, publisher or owner) joins its live session when their app opens the draft view online. They leave when they close it, lock, open another page, or stay offline for longer than their join lasts (decision 10). Readers never join, and never see that a session exists, except through `wikistow.live` in a publication an older app made (decision 5). Agents, the CLI, the chat assistant and plugins don't join (decisions 8 and 9).
- **Always, alone too.** The first editor to open the draft starts the session, and is alone in it until someone else comes. So there is one way to edit online, and a second person joins a session that is already running, with nothing to hand over. The cost is one snapshot upload when a draft is opened, and one small request about every tenth of a second while someone types (decision 11). Decide 2 covers the other way: start a session only when a second editor comes.
- **With a change waiting on the device.** An app with an offline draft change waiting for the page (ADR 0009) joins, and puts that change into the shared document as the person's own, merged from the text kept beside it (decision 10), or, for a change made with no session, from the version it was based on (decision 8). Beside the entry it records the client and clock of the change it made from it, so it never puts the entry in twice. The queue withdraws the entry once a draft of the session holds that change, so the device keeps it until it is saved. The queue holds back a draft entry only while a tab or window of this app is in that page's session, which each such tab shows by holding a Web Lock named for the page, released when the tab closes or dies; otherwise it sends it as ADR 0009 says, so a session nobody is in never holds it up. An entry it sent already either landed, and the saver folds it in, or came back as a conflict, and the app puts it in as above.
- **Each tab, window or device takes part on its own,** with its own Yjs client. Two tabs of one person show as one person.

### 2. The shared document

A session's document is a `Y.Doc` holding:

| Name | Type | Holds |
| --- | --- | --- |
| `title` | `Y.Text` | the title |
| `frontmatter` | `Y.Text` | the front matter as written, with its `---` lines; empty for a page without one, which a save writes as the body alone |
| `body` | `Y.Text` | the Markdown after the front matter |
| `attachments` | `Y.Map` | each attachment's `AttachmentRef`, by ID |
| `extensions` | `Y.Map` | each extension namespace's value, by namespace |
| `links` | `Y.Map` | which page a link means, where someone chose between pages of one title (`chooseLink`), by link key |
| `overlaps` | `Y.Map` | outsiders' drafts whose overlapping parts wait for review (decision 8), by revision ID |
| `fields` | `Y.Map` | any other top-level payload field, from a newer minor format, by name |

- **The payload a save writes is the first five put back together,** the front matter joined to the body as `joinPage` does today, or the body alone when `frontmatter` is empty, with `wikistow.overlaps` from `overlaps` and any other fields from `fields`. Map values are strings, each value's JSON text, so a payload goes through the document unchanged, a key named `__proto__` included. Attachments compare as a set, by ID: a save writes them in the order the draft it is based on had them, then new ones as they were added. So Markdown stays the page's canonical form, and the session changes no payload format. Each save works out `wikistow.links` as today, from the saver's tree, the table of the draft head it saves on, which the saver opens and passes on as today's save passes on its last table, and the choices made in the session, which `links` holds, so a choice anyone makes reaches the table and earlier entries are kept. The table itself isn't in the document, and neither is `wikistow.live` (decision 5) or `wikistow.change`, which a draft save always drops. As for any writer, which pages a link may name follows what the writer sees (protocol section 5.5), and the writer is the saver.
- **Yjs** (13.6) merges changes made at the same time. Text merges character by character. A map entry merges by key; when two people set one at once, one of the two wins, the same for everyone. When two people type in one sentence, both keep their typing, in the order Yjs gives, which is the same for everyone. Two people changing the same characters at once can leave Markdown that reads oddly, such as a doubled `**`, and both see it and either can fix it. ADR 0013 turned down merging by character for drafts nobody saw being made. In a live session, people watch each other type.
- **Undo** undoes only the person's own changes, in both editors.

### 3. The two editors

**Source mode** binds CodeMirror to `body`, as `y-codemirror.next` does, through a small adapter of the app's own: on a page with CRLF line breaks the editor counts each as one character (`lineSeparator`), where `body` holds two, and the adapter converts positions as `replace` does today. It also widens each change to whole characters, since CodeMirror's own diff can start or end one inside an emoji's two halves. Others' changes arrive as small edits, and others' carets and selections show (decision 7).

**The visual editor** works by block.
- **Its own edits.** A local edit writes the blocks it changed, and nothing else. Every top-level block keeps the source the shared text holds for it until someone edits that block. So an edit in the visual editor never restyles the rest of the page under someone typing in source mode.
  - A changed block's new text goes into `body` as the smallest change in characters from the text the editor last took in for that block. If someone else changed the block since, and their change hasn't reached this editor yet, that change is carried through: the editor's change is moved onto the block's text in `body` now, by a character diff from what it took in, so both people's typing stays. Before taking in someone else's change to a block, the editor writes its own unreported edit of that block. Every change to the shared text starts and ends between whole characters, never inside an emoji's two halves: Yjs would store each half as U+FFFD, so the others would see two marks where the writer still sees the emoji. The diff costs 5 to 10 ms on a page of 60 to 200 KB, measured on the whole text (spike below), and less for one block.
  - This needs a map from each top-level ProseMirror node to its source in the shared text, which the editor doesn't have today (step 2). The map serves the visual editor alone too: it stops restyling blocks nobody edited, and ADR 0013's merge then meets fewer overlaps.
- **Others' changes.** Someone else's change touches some characters of `body`. The editor finds the top-level blocks those characters fall in, reads those blocks again with the blocks beside them, as it reads a paste, checks them, and replaces just those nodes. It maps the person's selection across the change and keeps the change out of their undo history.
  - Some Markdown reaches past its block: a code fence or HTML left open, a link definition, a footnote. When a change adds or removes one, or the blocks read again don't end where they did, the editor reads the page whole, as it does today. It doesn't wait for the typist to pause, as split mode does: it reads at most every second, or every twice as long as the last whole read took, so on a 200 KB page, with a fence left open while someone types a diagram, the viewer's visual editor catches up every 5 s or so and holds its thread for up to half a second each time.
  - Checking a block with the blocks beside it took 6 to 38 ms, on pages of 5 to 200 KB, against 0.9 s at 60 KB and 2.5 s at 200 KB for today's whole-page check and `show` (spike below). The spec gives a paste, the same work, as about 50 ms at 100 KB and 80 ms at 200 KB.
  - Changes that arrive within 100 ms of each other go in together.
  - A block the person is composing a word in, with an input method (most phone keyboards do this for every word), takes others' changes only once the composition ends, a wait the editor doesn't have yet: today it only skips work while composing (`view.composing`).
- **What it can't show.** Another person may give a block something the visual editor can't read back the same, such as raw HTML. The viewer's visual editor then switches to source mode and says who changed it ("Sam added something the visual editor can't show"), as opening such a page does.

**Split mode** shows the shared document in both panes. Each pane takes the other's changes as it takes anyone's.

**The rest of the page.** The properties box edits `frontmatter`, as the smallest change in characters, as the visual editor writes a block. The cover edits `extensions` (`wikistow.cover`). A file goes into the shared document, its link with its `AttachmentRef`, only from the app that uploaded it, and only once that app's own save of it has landed: the server lets only a file's uploader commit it to a revision until it is committed (`attachBlobs`), so the saver's save would otherwise fail as `missing-blob`. The uploader's app makes that change in a copy under a client of its own and saves it, as the saver makes a fold (decision 5), and sends it once the save lands.

### 4. Sealing and relaying

**The session record** is a metadata record v2 (protocol sections 5.4 and 5.7), as a comment is (ADR 0014):
- **The record.** `subjectKind: "live"`, `subjectId` the session ID (`newId`), and `basedOn: null`. It is signed by the editor who starts the session.
- **Its key material** is in the region of the page's draft (protocol section 6.1):
  - in a share, one key wrap with `audienceClass: "draft"` and `subjectKind: "live"`, under the draft key at the current key version;
  - in the owner region, v2 metadata envelopes to the sealing owners.
- **The payload,** session format 1.0, is `{format, pageId, revisionId, key, sealedTo, extensions}`. `revisionId` is the draft the session started from, and `key` is the session key: 32 fresh random bytes. In the owner region, `sealedTo` lists the owners it was sealed to; in a share it is `null`.

The app that opens the record checks it as a metadata record v2 with `subjectKind: "live"` and the session's ID. It also checks that `pageId` is this page, and that the key material is in the region of the page's draft it opened (`region-mismatch` otherwise). Then it checks that the session is no older than what the app knows of access to the page, as a writer does (protocol section 6.8). In a share, the wrap's key version must be the highest the app holds that counts for writing, and not below its **No going back** mark. In the owner region, every owner in `sealedTo`, the record's signer and every envelope's granter must be among its sealing owners now, since anyone can seal to owners' public keys, and a removed owner who started a session would otherwise read all its typing. Otherwise it refuses to join (`key-version`, or `unaccepted-owner`), reports it, and edits as an outsider. An app leaves a session in a share as soon as it holds a newer key version there that counts for writing, however it learns of it, and one in the owner region as soon as an owner in `sealedTo`, or the record's signer, stops being one of its sealing owners. It also leaves as soon as the page's draft region, as it knows it, isn't the region of the record's key material any more, as after a move or the ending of a share, which rotate nothing, or when the share carries its **No going back** mark as ended. It joins only a new one. So a server that keeps an old session open can't get its keystrokes sent under a key a removed person holds. Readers hold no draft key, so they can't open it. A member can't put a session wrapped under another share's key on a page. The record needs no new record format and no new domain strings.

**A message** is a change, a snapshot, a presence or a save notice:

```
LiveMessage = { kind: "update" | "snapshot" | "presence" | "saved", senderId, senderKeyVersion,
                joinId, seq, sealed: Sealed, signature }

ad        = canonical('live-message-payload/v1', [installationId, spaceId, pageId, sessionId, kind,
                                                 senderId, senderKeyVersion, joinId, seq])
sealed    = XChaCha20-Poly1305(sessionKey, random 24-byte nonce, pad(clock ‖ content), ad)
signature = Ed25519(sender, canonical('live-message/v1', [installationId, spaceId, pageId, sessionId,
            kind, senderId, senderKeyVersion, joinId, seq, payloadHash]))
```

- **`joinId`, `seq` and `clock`.** An app makes a fresh `joinId` (`newId`) each time it joins, and numbers the messages the server stores (changes, snapshots and Saved notices) from 1 with `seq`. Each of its joins has one request in flight at a time, and the server stores and relays each join's messages in `seq` order. Every message starts, inside the ciphertext, with `clock`: its Yjs client's clock once the message's changes are in, a change that only deletes included, so others know how far its typing has gone. It is sealed, not on the wire, since it counts exactly the characters typed, which the server mustn't learn. A presence carries the `seq` of the last stored message before it, 0 if there is none yet, and doesn't count, since the server keeps only the latest presence, in memory, and a newcomer may get it before the stored messages it follows.
- **Padding.** A change's size says where in the page it is, since Yjs writes positions as numbers of varying length: one character typed near the top of a 60 KB page takes 33 bytes, near the end 37. So every plaintext is padded to a multiple of 128 bytes (`pad`: one `0x80` byte, then zeros) before sealing.
- **Checks on receipt.** The receiving app takes a join's messages in `seq` order: it drops a repeat, by `(senderId, joinId, seq)`, and refuses one whose `seq` is below the last it took from that join. It refuses a message whose signature fails, whose sender's key fails the pins (protocol section 8.4), or whose `(senderId, senderKeyVersion, joinId)` the server doesn't list among the session's joins, past and present.
- **A change** is a Yjs update. Its Yjs client ID is derived from its sender: `BLAKE2b-64(canonical('live-client/v1', [installationId, sessionId, senderId, senderKeyVersion, joinId]))`, cut to 53 bits. Deleting other people's text is a change like any other. The receiving app refuses an update:
  - that adds anything under another client ID, so a member can't write as someone else's client;
  - that adds anything outside the document's eight parts, or anything but text in its text parts and strings in its maps, deleted content aside. Yjs places a struct, and so shows which part it is in, only as it applies it, so the app checks each as it is placed, and one that doesn't fit makes the session out of step (decision 5). What the app then saves, and merges from, is its document's text as Yjs reads it.

  The app also refuses an update that deletes text beyond what its writer's join has signed as typed, by the highest `clock` that join has signed, so nobody can delete in advance what someone types later. An update deleting text the app doesn't hold yet but whose join has signed it waits, as Yjs holds it, until the text arrives.

  A message sent again after a lost answer goes unchanged, with the same `seq`, so it is dropped as a repeat. Only people take part, so the app also refuses a message from an agent's identity.
- **Presence** is `{editor: "source" | "visual", visible, publishing, saveFailing, cursor}` (decisions 5 and 7): `publishing` while its app publishes, and `saveFailing`, with the reason, while its saves fail.
- **Saved** is `{revisionId, state}`: the saver saved this revision, which holds the document as of that state.
- **A state** here is a Yjs snapshot of the document: its state vector, which counts what each client added, and its delete set, which says what was deleted, so a deletion counts as a change. One state holds another when its state vector is at least the other's for every client and its delete set covers the other's. The request also names, unsigned, the position up to which the saved document held every stored message, so the server can tell what is saved (decision 12). A later message the document also held, such as the saver's own change still on its way, doesn't move it.
- **A snapshot** is `{revisionId, state}`: the whole document as one Yjs update, as of the save of `revisionId` (decision 6).

This adds three domain strings: `live-message/v1`, `live-message-payload/v1` and `live-client/v1`.

**Relaying.**
- The app sends its changes at most every 100 ms, merged into one update, with `POST /api/live/:sessionId/messages`, one request carrying its change and its presence together.
- It reads everyone's messages from one stream, `GET /api/live/:sessionId/stream`. That answers NDJSON as the tree's stream does, with the participants, each message with a position the server gives it, and a line when the session ends.
- Opening the stream is joining. Leaving says so (`POST /api/live/:sessionId/leave`, sent as the page closes, with `keepalive`), and 30 s without the stream, or without any message from the join, presence included, counts as leaving too: a laptop that sleeps leaves its connection looking open for minutes, but stops sending presence. An app whose stream broke opens it again with the same `joinId` within those 30 s, and so keeps its client and sends what it hadn't.
- The server checks that each message's sender is the caller, is in the session, and can edit the page. It stores changes, snapshots and save notices in order. It passes presence on, and keeps only each present join's latest, in memory, for newcomers.
- It fans messages out in memory, as the tree's stream does, in the one server process.

Decide 7 covers WebSockets instead.

### 5. Drafts: the saver

- **One app saves.** The saver is the participant the server has listed longest whose page is visible, or, if no page is visible, the participant listed longest. Every app works the saver out from the same list, and from each join's latest presence, which the server keeps in memory and sends to a newcomer. Two apps may still both take themselves for the saver for a moment; the server's head check lets only one save through each time, and nothing a save changes is sent until it lands (below). A hidden tab's timers slow down, so a hidden tab doesn't save for others while a visible one can.
- **It autosaves the shared document** on today's cadence: one second after the last change from anyone, and at least every 10 s while changes keep coming. It is an ordinary draft save, based on the draft head, with the permission version and the key material of the page's region, and signed by the saver. The server checks it as it checks any save, and nothing changes there.
- **`wikistow.live`**, a new payload extension, says what the revision holds: `{format: 1, revision, session, state, with}`.
  - `revision` is the revision's own ID, `session` the session ID, `state` the state the revision holds (decision 4), and `with` the IDs of the others who wrote in the session.
  - **A revision counts as the session's only when `revision` is its own ID** and `session` is the session, as `wikistow.change` counts (protocol section 5.5). A writer outside the session that keeps the extension, as every client keeps a namespace it doesn't know, copies one naming another revision, so its save counts as an outsider's and is folded in (decision 8).
  - It goes into drafts only, a restore made in the session included. Publishing, detaching, copies and publications into other spaces leave it out.
  - A client from before it copies it into what it publishes. That shows readers the session ID, how many characters each Yjs client wrote, and who else edited, but nothing of the text.
- **What a save itself changes goes out only once it lands.** Today a save may rename links (protocol section 5.5, **Renames**) and repair the text, and the editor takes the result back; the saver's fold of an outsider's save (decision 8) changes the text too. In a session the saver makes such changes in a copy of the document under a Yjs client of its own, with a `joinId` of its own, made for that save. Its main join sends no change built on the copy's change before the copy's change is placed. Before the save goes out, it makes that join by sending from it a message holding no change, naming its own join as `parent`, so the server lists it as belonging to that join, going when that join goes. It saves the copy, with the copy's state in `wikistow.live`, and sends the change from that client only once the save has landed. A save the server refuses leaves nothing behind, so if two apps make the same change at once, it goes in once. If the save's answer is lost, the app sends the same save again, as ADR 0009 does: `duplicate` means it landed. Once that change is placed, the saver sends a Saved notice naming its position, so the server knows the session is saved. Yjs gives a document a new random client ID when an update adds anything under its own; the app keeps the derived one, and leaves the session if Yjs changes it. Another app's save renames and repairs nothing, but a restore, which the restorer makes in a copy of its own (decision 8) and which renames links as a restore does today.
- **Each app knows when its own typing is saved:** when the draft head is a revision of its session whose `state` holds all of its own changes, and its own document holds that `state`, so the draft claims nothing the app hasn't seen, and the app has checked that draft or a later one holding its changes, as **Checking the saver** says. It learns of saves from a **Saved** message, which every app sends after a save of its own, or by opening the head. Until then the page shows "Saving…", and leaving or locking saves the app's own document unless the head is a draft it has checked. Leaving, locking or hiding the page sends whatever is still unsent, and leaving or locking also saves, when the head doesn't hold the app's changes. A tab hidden for a minute does the same and leaves the session, closing its stream, as the tree's stream already closes in hidden tabs, and joins again when shown.
- **Any app may save** at once when it needs to, to publish or to leave with changes the head doesn't hold, provided its document holds everything the head does. If that save meets `stale-head`, the app reads the new head:
  - a revision of the session that holds its changes means it is done;
  - a revision of the session that doesn't means it catches up and saves on top;
  - a revision from outside the session goes to decision 8.

  A revision of the session whose `state` holds changes the app can't get, because their sender's join has gone without sending them (a sender cut off, or a session ended mid-typing), is folded in as an outsider's is, so the app never saves over it. It waits for the join to go, 30 s after its stream broke, since until then the sender can still send them, and folding first would put the text in twice. Once it has folded in a join's changes, it refuses that join's messages from then on, so a server that called a join gone and then relays its changes after all can't get the text in twice. Changes under a join a save made for itself (below) go when the join that made it goes.
- **Which drafts are the session's.** The draft the session started from counts as its base, with the first snapshot's state. After that, a draft counts as the session's only when its `wikistow.live` names it and the session (above), and its signed author is a person the server lists among the session's joins. Anything else is an outsider's.
- **When the saver can't save.** If the saver's save fails for a reason of its own, such as its storage being full or its connection, its presence says so, and the next app in the order saves instead, which the page shows ("Sam's saves are failing; Rita's app is saving"). So does any app, once changes have waited 20 s for a save that hasn't come. A failure that comes from the page itself, such as the draft being too large, would fail for anyone: nobody takes over, and everyone's page says what is wrong ("This page is too large to save. Remove something to save it") until someone fixes it.
- **A draft that claims what never came.** A session draft's `state` may hold changes the app doesn't have. If they are under the client of a join that has gone, they are folded in (above). If the app still doesn't hold the draft's `state` after 30 s during which the joins that could send what's missing have had their streams open, apart from those, the draft claims what never came, and the session is out of step, as below. That covers a client no join explains.
- **Checking the saver.** Whenever an app's document has exactly the `state` of a saved draft of the session, as at most quiet moments, it opens that draft and compares the payload it would write with the draft's, `format`, `wikistow.links`, `wikistow.live` and `wikistow.change` aside, attachments as a set. It checks at most every 10 s, within the fetch limit, and a check that can't run waits for the next quiet moment. If they differ, the session is out of step: the app says so, takes nothing in that draft as saved, leaves the session and edits as an outsider. Its next save meets the conflict, and **Merge…** shows the person the difference. Once that is resolved, merged or saved and folded in, the app joins the session again as a newcomer. So a saver can't drop someone's paragraph from a save while claiming to hold it, and two apps that disagree don't save over each other in turn.
- **Who signs.** A draft revision is signed by the app that saved it, and in a session it holds other people's typing. So a draft's signed author says who saved it, not who wrote every word, and `with` names the others on the saver's word. History shows each version's publisher, as today. For editors, who can open the draft a publication was made from, it can add that draft's author and the people `with` names ("drafted by Rita with Sam"), which is new work: history doesn't show draft authors today. Decide 9.
- **Publishing** saves first, as today, and then publishes the head. While it does, its presence says so, and the saver holds its saves for up to 10 s, so the head stays put. If it moves anyway, the publish meets `stale-head`, and the app publishes the newer head only if it is a draft of the session that its document holds and has checked (below); otherwise it stops and says to try again, as today. What goes out is the shared draft as everyone in the session sees it at that moment, half-typed sentences included. So while others are editing, **Publish** says so ("Sam is editing too").
- **Nothing typed is lost when everyone leaves at once.** The server keeps a session whose last change came after the position its last Saved notice names. The next editor to open the page joins it, and their app saves it.

### 6. Catching up

- **Snapshots.** The editor who starts a session sends its first snapshot with the session record, made from the draft it opened, with the text repaired as a save repairs it, under its own client alone. A newcomer compares snapshots with revisions repaired the same way. After that, the saver posts a snapshot once the changes since the last one pass both 256 KB and the size of the last snapshot, so uploading snapshots costs no more than the typing itself. It posts it from a join of its own, made as a save's is, so its typing doesn't wait behind the upload. Each is the document as of one of its saves, once every change the snapshot holds has been sent and placed by the server. The server then deletes the changes the snapshot holds, but keeps each join's latest stored message. While the session is kept, open or ended, draft retention keeps the draft it started from and the drafts its kept snapshots name, so a newcomer can always open them.
- **A newcomer** fetches the session with `GET /api/pages/:pageId/live`: the record and its key material, the latest snapshot, and the changes after it.
  - It opens the revision the snapshot names. The snapshot must hold the document's eight parts and nothing else, each holding only what its kind allows (decision 4), and its payload, put together as a save writes it, must equal that revision's title, Markdown, attachments as a set, extensions and other fields, `format`, `wikistow.links`, `wikistow.live` and `wikistow.change` aside.
  - The first snapshot is the one the record's signer sent with the record, naming the record's `revisionId`. It must hold changes of its sender's client alone. A later one must have the revision's `state` as its own. Every range of text it adds, and every range it deletes, must be under a client within the highest `clock` that client's join has signed in a kept message, the first snapshot counting for its sender's join, and once applied it must leave nothing waiting in Yjs. Yjs's own state and state vector don't show what it holds back, so the newcomer decodes the snapshot to check. The newcomer checks this from those signed messages, which the server keeps when later snapshots delete the rest.
  - Otherwise it refuses to join, says why, and edits as an outsider.
  - So a snapshot's text is checked against a signed revision, and it can't claim typing someone hasn't done yet: Yjs would skip that typing when it came, without a word. Its history before that isn't checked (see the threat model).
  - Then it applies the later changes and joins the stream from that position.
- **A brief drop**, such as a broken stream or a laptop that slept, resumes within 30 s from the last position the app had, with the same `joinId`. It fetches what it missed, from the latest snapshot if a snapshot has deleted those changes since, and sends its own unsent changes, which Yjs tells apart by state. Yjs takes what it already holds once, so there is no conflict.
- **A longer drop.** Once the server has dropped its join, the app can't send what it typed under that client. It joins again as a newcomer and puts its unsent typing in as one change, merged by block (decision 8). The base is its **acknowledged copy**: a second Yjs document every app keeps beside its own, holding every change it took in from others and each of its own once the server placed it, so it is the app's document without its unsent typing. Other people's typing is then in the base and on both sides, and only what the person typed counts as theirs. Before merging, the app also adds to the base its own changes the session already holds though the server's answer never came: as a newcomer it finds them under its old client in what it fetched, and on the queue path the head's `wikistow.live.state` says how far its old client got. Where it overlaps, **Merge…**. Going offline is decision 10.
- **Measured** (spike below): a snapshot opens in 15 to 50 ms. Without snapshots, catching up on an hour of two people typing nonstop would mean replaying 11 MB of changes, which takes 9 s.
- **A session that grows too big** starts again. That is a snapshot past 2 MiB, which the server won't take, about four hours of two people typing nonstop. The saver saves and ends the session (`POST /api/live/:sessionId/end`), and every app joins a new one from that revision, putting in what the end refused as at an end for access (decision 12).

### 7. Presence

- **Who.** The toolbar shows the others who have the draft open, where the layout keeps a place for viewers: their initials in a colour taken from their identity, and their names on hover ("Sam and Rita are editing"). On phones it shows a count. The server's list says who is there, and the pinned labels name them (protocol section 8.2).
- **Where.** In source mode, others' carets and selections show in their colour, with their name on the caret. In the visual editor, a bar in their colour sits beside the block their caret is in, because the editor maps source to blocks, not to positions within a block (Decide 6).
- **Sealed.** A cursor is a Yjs relative position in a presence message. Presence is sent when the cursor moves, at most every 100 ms, and every 15 s besides. The server passes it on, and keeps only each join's latest, in memory, for newcomers.
- **Not for readers.** The published view shows nothing of a session.

```
Draft view, source mode                         Visual editor
┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ (Family › Recipes) (S)(R) History [Publish]│ │ (Family › Recipes) (S)(R) History [Publish]│
│ Lasagne                       Saving…    │   │ Lasagne                        Saved     │
│                                          │   │                                          │
│ ## Method                                │   │  Method                                  │
│ 1. Brown the mince with the onion.       │   │  1. Brown the mince with the onion.      │
│ 2. Bake at 180 °C for 45 minutes.|Sam    │   │ ▌2. Bake at 180 °C for 45 minutes.  Sam  │
│ 3. Rest for |Rita 10 minutes.            │   │  3. Rest for 10 minutes.                 │
└──────────────────────────────────────────┘   └──────────────────────────────────────────┘
(S)(R): Sam and Rita, in their colours. |Sam: Sam's caret. ▌: the block Sam's caret is in.
```

### 8. Writers outside the session

Anything that saves a draft without being in the session keeps today's check: its save names its base, and `stale-head` refuses it when the head has moved on.

- **Who.** The CLI and agents (MCP included), offline changes when they are sent, and older apps. Also folder table cells, changes made while reading (ADR 0008), and a restore by an older app.
- **While people type,** the saver moves the head at least every 10 s, and a second after each pause. So an agent that read the page a minute ago meets `stale-head`, reads it again and tries again, as it would today after any save. Its write lands only if no save comes between its read and its write. An agent that takes a couple of seconds usually lands; one that takes as long as the gaps between people's pauses, a few seconds in ordinary typing, rarely does. It can wait, or add a comment for editors (ADR 0014), and the agents guide says so. Agents joining sessions (decision 9) is the way out; Decide 5 has another.
- **A save that lands** makes the head a revision from outside the session, and the saver folds it in.
  - It merges by block with ADR 0013's `pageMerge`. The base is the latest draft of the session the outsider's save descends from, found through `basedOn`, theirs is the outsider's revision, and ours is the shared document now.
  - It makes the result in a copy of the document under a client of its own, changing only the parts the merge changed, and saves that on top of the outsider's revision. Only once the save lands does it send the change (decision 5).
  - **When the session changed nothing since the base,** the result is the outsider's revision itself, and a second draft would make the page show unpublished changes it doesn't have, which stops ticking while reading (ADR 0008) and an agent's publish. So the saver saves nothing. With the grant (above) it sends the change, and the outsider's revision stays the head. The stream marks the grant and the position of its change, the session route lists grants for newcomers, and the server gives no second grant for a revision already folded, so every app counts that revision as the session's, holding the base's state as the session counts it (the first snapshot's, for the draft the session started from) plus that change's own additions and deletions, which every app works out the same, and any participant may save on top of it. Typing anyone sent around the same time isn't in it, so it shows as unsaved until the next save. A Saved notice naming that revision follows, so the server knows the session is saved.
  - **One fold per save.** Before it folds, saved or not, the saver takes the server's grant for the outsider's revision (`fold` on its messages request), which the server gives to one join at a time per revision, only while that revision is the draft head. An app that doesn't get it drops its copy and takes the other's change. The grant lapses, and the next saver may take it, if its join goes, or if 30 s pass without the head moving on from that revision or the grant's change being placed, which are what the server can see; so one app's full storage or closed tab doesn't stop the session saving. So the outsider's change goes in once, even while the saver changes hands.
  - **Save mine on top from outside.** A person who saves over the session from outside it with **Save mine on top**, as an older app's conflict prompt offers, saves text that undoes what the session typed since they opened it, and the fold takes that as their change, as it does today over any writer. New apps offer **Merge…** first; updating older apps closes this.
  - **Where they overlap, the session's text stays.** Everyone in the session sees a note: "Sam's agent changed this page while you were editing, and 2 changes overlap yours. Review". **Review** opens ADR 0013's view for those parts: theirs, ours, both, or an edit. Whoever reviews makes the choice as their own change to the shared document. **Review** works the overlaps out again from the session's draft the outsider's revision is based on, that revision, and the document as it is then, so it works on any device, later too. Until someone does, the document's `overlaps` names the outsider's revision, and the draft carries it as the `wikistow.overlaps` extension, so whoever opens the draft later sees the note too. Each note is its own entry, so reviewing one while another is added keeps both. The revision stays among the draft's checkpoints for 30 days after it is saved over, and the note goes with it. **Dismiss** drops theirs in those parts for good. Decide 5.
- **A plugin's edit from an older version.** A plugin's edit of a page open in this window (`drafts.through`) is made from an older version of the page. It goes into the shared document as the person's change, merged the same way from the version it was made on, with **Merge…** where it overlaps. It isn't an outsider's save.
- **The chat assistant's approved change** stays the assistant's, as today: the person's app saves it under the assistant's own agent credentials (`applyProposal`), signed by the assistant and checked by the server against its grant, so the page's agent card names it, as today. It is an outsider's save, made on the current head: the app merges the proposal from the version it was made on onto that head first, with **Merge…** where it overlaps. On `stale-head` it merges that result, as the person settled it, onto the newer head from the head it was settled on, so a choice once made isn't asked again, and **Merge…** opens only for a new overlap. The saver then folds it in.
- **Restoring a version** while a session is open goes through the session: the restorer's app joins it if it isn't in it, puts the version's text in as its own change, replacing the page's, made in a copy under a client of its own as a file is (decision 3), since its files are sealed again for the draft and only the restorer can commit them, and saves that itself, with `restoredFrom`, as a draft of the session with `wikistow.live`, so nobody folds it in. Others typing at that moment keep what they type, where Yjs places it in the restored text.

### 9. Agents, the CLI and plugins

- **Agents and the CLI** don't join sessions. An agent isn't watching a cursor, and the stream is for people only. They are outsiders (decision 8). `wikistow page read` says nothing new, but for one thing: it names the notes waiting for review that point at the agent's own drafts (decision 8), so an agent doesn't take its missing change for a failed save and make it again. Agents joining sessions, to write while a person watches, is later work.
- **Comments** (ADR 0014). A comment for editors that quotes a passage names a version holding the text quoted, so the commenter's app saves first, as it does today; in a session it saves the shared document (decision 5) and names that draft.
- **Plugins edit through the editor, as the person.** `PageHandle.editor.insert`, toolbar buttons and plugin blocks are the person's changes, in the session like typing. `contentChanged` (#289) fires for others' changes too. A plugin's `PageHandle.edit` of the open page goes in as decision 8 says. Plugins see nothing of presence.

### 10. Offline, and older apps and servers

- **Offline** (ADR 0009). The app counts as offline from the first request that gets no answer, which with a request every tenth of a second is any blip. So it keeps its place in the session for as long as its join lasts, 30 s, and while it is in a session it asks whether the server is back every 2 s rather than today's 30, opening the stream again as soon as it is: its typing waits unsent in its document, and when the server answers again it resumes as decision 6 says, with no conflict. Meanwhile what it typed is also kept sealed on the device, as an offline change waiting for the page that the queue holds back, with the acknowledged copy's text beside it, so a tab closed or locked in that time loses nothing; resuming withdraws it, and if the join goes first, it is the offline change below. Only once its join has gone does the app leave the session. What the person typed that the session didn't take, and what they type next, go into the offline queue, as today, based on the session's last revision the app knew. Beside the entry it keeps the text of its acknowledged copy (decision 6), sealed like the entry. Back online, the app joins again and puts the entry in as the person's own change, merged from that text (decisions 1 and 6). If no tab or window of this app is in the page's session, the entry goes out as ADR 0009 says, and if it meets a conflict, **Merge…** takes that kept text as its base too, so other people's changes the app had taken in don't count as the person's. A publish waiting for the entry (#331) isn't sent: the page says so, since others are editing, and the person publishes again. Other people's changes the app had taken in are in that base, so only what the person typed is added.
- **Older apps** don't know sessions, so they are outsiders. An older app with the draft open beside a session learns of the session's saves when its own save meets `stale-head`, or when its window comes back into focus and it loads the page again (`noticeHead`), and then shows the conflict prompt. Since 0.25 that prompt offers **Merge…**. The session folds in what it saves, and its **Save mine on top** undoes what the session typed since it opened the page, as it would over any writer today (decision 8). Updating the app ends this.
- **Over HTTP/1.1.** A browser allows six HTTP/1.1 connections per server, and a visible tab with a draft open would hold three streams, the tree's, the comments' and the session's, so two windows would leave none for saves. So the browser app joins sessions only when its requests to `/api/` go over HTTP/2 or later, by the `nextHopProtocol` of such a request's resource timing entry (the page itself may come from the service worker, which says nothing), and otherwise edits as today and says live editing needs the server set up for it. The desktop app forwards through Node, which has no such cap.
- **An older server** answers the session route `not-found`. The app then edits as today, and says nothing.
- **A newer major format** of a session or of `wikistow.live`: the app says "Update the app to edit with others" and edits as an outsider.

### 11. Cost on large pages

| | Cost | Grows with |
| --- | --- | --- |
| Seal and sign a change | 0.16 ms | nothing |
| Check and open a change | 0.25 to 0.38 ms | nothing |
| Apply it to the document | 0.03 ms | nothing |
| On the wire | about 400 bytes per change, padded, at most 10 a second per typist | typing |
| Source editor | a CodeMirror transaction per change | nothing |
| Visual editor, its own edit | the blocks changed, as today, plus a diff of their text | the blocks changed |
| Visual editor, others' changes | the blocks touched and those beside them: 6 to 38 ms to check, plus replacing those nodes, at most every 100 ms | the blocks touched |
| Visual editor, a change that reaches past its block | the whole page, as today: about 0.9 s at 60 KB and 2.5 s at 200 KB, at most every second or twice the last read | page size |
| Saving | today's autosave, by one app for everyone, each draft also carrying the session's state in `wikistow.live`: about 15 KB per hour of two people typing, 63 KB after four, kept 30 days like any draft and charged to the saver | page size, and the session's history |
| Checking saves | each other app opens the draft head at a quiet moment, at most every 10 s per tab: one download and decryption of the page | page size |
| Snapshots | the saver uploads the whole document now and then, at most as much as the changes since the last; late in a long session about 0.5 to 2 MB a time | the session's history |
| A newcomer | one snapshot, 15 to 50 ms to open, plus the changes since | the session's history |
| The server | per request, at most 10 a second per typist: a rate-limit count, an access check and one row per change, deleted with the session | typing |

A key typed reaches the others in about the 100 ms of batching, plus the round trip, plus at most 100 ms more in the visual editor. That is well within the second the issue asks for, except while a change reaches past its block and the visual editor reads whole (decision 3): then, on a 200 KB page, about 5 s. The visual editor's own costs while typing stay as the spec gives them: on a 100 KB page, about 7 ms a key, with tasks of 50 to 80 ms.

### 12. Ending

- **Everyone left.** A minute after the last participant leaves, if the position the last Saved notice names is the session's last change, the server deletes the session: its record, key material, snapshots and changes. A session with changes after that is kept for the next editor, up to the draft retention (30 days), and then deleted.
- **Access changed.** The server ends the page's session at once, and tells its participants, when the page's permission version moves. That covers a key rotation, a member or role change, a move, making or ending a share, an owner change, unpublishing, and the trash. It takes no more messages for it but Saved notices.
  - Each app takes the new access. If it can still edit, it saves what the head doesn't hold, when its document holds the head, and otherwise folds what it has into the next session as decision 8 does. Changes the server refused at the end, typed in the last tenth of a second, are among them, so two people who typed in one block just then get **Merge…**. Those who can still edit then join a new session, under new keys.
  - A removed person keeps the session key they held. It opens only that session's ciphertext (A3), so nothing typed after the end reaches them.
  - **Changes nobody saved, when nobody is there.** A session holds changes no revision does only when every app in it went without saving, as when the saver's tab crashed and nobody else was there. An app leaving or locking saves first (decision 5), but a tab closed within a second of typing sends its last change, small enough to go as the tab closes, and may not finish its save. If access then changes, the server keeps the ended session, read-only, for the next editor, up to the draft retention. If its keys still count for writing for that editor's app, as after a member added or an unpublish, the app catches up from it and saves what the head doesn't hold: on top of the head, if the head is the ended session's latest draft, and otherwise by merging the ended document's text into its new session as decision 8 does, from that latest draft. Then it sends a Saved notice, and the server deletes it. After a key rotation or a move to another region its keys don't count, so its unsaved changes are lost.
- **The saver ends it** to start again (decision 6).
- **The page went.** Deleting a page moves it to the trash, which is a change of access, so the session ends as above, and one with unsaved changes is kept for after a restore. Deleting it for good, or deleting its space, ends the session with nothing to save.

### 13. Routes

New routes only. No existing route or response changes.

| Route | Does |
| --- | --- |
| `GET /api/pages/:pageId/live` | For people who can edit the page, the open session, and beside it any ended one kept with unsaved changes, each with its record, the caller's key material, the first snapshot, the latest snapshot, each join's latest kept message, and the changes after the latest snapshot, with the fold grants since then and the one for the current head; or neither. |
| `POST /api/pages/:pageId/live {sessionId, joinId, revisionId, metadata, wrap \| envelopes, snapshot, permissionVersion}` | Starts a session, with its first snapshot, and makes the starter's join, present for 30 s until its stream opens. It takes the snapshot route's body limit and pool. If a session is already open, it answers `duplicate`, and the app fetches that session. |
| `GET /api/live/:sessionId/stream?after=&joinId=` | The stream, in NDJSON: the session's joins, past and present (each with identity, key version, join order, `joinId`, the join a save's own join belongs to, and whether it is still there), the messages after the given position, each fold grant with its holder and, once placed, its change's position, and `{ended: reason}`. Opening it joins the session. |
| `POST /api/live/:sessionId/messages {joinId, messages, parent?, fold?}` | Sends messages. A Saved notice also names, unsigned, the position it covers, and `fold` asks for a fold grant (decision 8). |
| `POST /api/live/:sessionId/leave {joinId}` | The join leaves at once. |
| `POST /api/live/:sessionId/snapshots {joinId, message, covers, revisionId}` | Posts a snapshot, naming in the clear the draft it was made at, so the server keeps that draft. |
| `POST /api/live/:sessionId/end` | A participant ends the session, as the saver does to start again. Changes the end refuses are put in by their apps as at an end for access (decision 12). |

**Limits:**
- a change is at most 512 KiB sealed, within the ordinary 1 MiB limit for a request. Snapshots go on a route of their own, `POST /api/live/:sessionId/snapshots`, at most 2 MiB, with a 4 MiB body limit and a pool of its own for large bodies, so typing never waits on the slots that making shares and moves use;
- a request at most every 100 ms per tab, carrying the tab's changes, presence and notices together, and `LIVE_LIMIT` allows 3,000 requests a minute per person, enough for four tabs typing at once with room for snapshots and a save's own join;
- the stream has no write limit.

All of these are for people only, as the other streams are. They answer an agent's credential `not-found`.

### Out of scope

- agents in a session;
- presence outside the draft view, in the sidebar or the published view;
- exact carets in the visual editor;
- who typed which part (blame), kept after the session;
- live editing of folder names and of plugin drafts;
- sessions between devices with no server;
- one session over several pages.

## Threat model

Live sessions add a channel, not new content. What is typed ends up in draft revisions, protected as today. Section 2.3's guarantees cover the session's messages as they cover drafts.

- **Readers never get the session key.** It is under the draft key, or sealed to the owners. Apps open a session's wrap only as the `draft` class, with the draft key, so a wrap under the published key opens for nobody. A server that relays a session to a reader (A1) relays ciphertext the reader can't open. An editor can hand a reader the key, as they can hand over a draft.
- **What the server learns** (A7, extended):
  - who has which page's draft open, and when they come and go;
  - when and how much each person sends. Changes go out at most every 100 ms, so the server sees typing to the tenth of a second, and roughly how many characters;
  - how big each snapshot is, which says how much the session has edited.

  It never learns the text, where anyone's cursor is, or who wrote which part.
- **A malicious server** (A1, A2):
  - **What it can do.** It can drop, delay or reorder messages, hide a participant, end sessions, or keep a session's ciphertext.
  - **Reordering** within a join can't happen, since a join's messages keep `seq` order. Reordering between joins is harmless for additions, which Yjs takes in any order; a deletion delivered before what it deletes is refused (decision 4), so it acts as dropping does.
  - **Deleting in advance.** A member can't send a deletion of text someone types later, since apps refuse a deletion past what that text's join has signed (decision 4).
  - **Dropping** leaves apps apart. An app saves only a document that holds the head, so it never saves over a change it hasn't seen. Instead it says "Can't catch up with the others". After 30 s the draft is out of step (decision 5): it leaves the session and saves as an outsider, which gets the conflict.
  - **What it can't do.** It holds no session key, so it can't write a change, a snapshot or a presence.
  - **Records from another share.** It can serve a session record a member made under another share's key, and the app refuses it (`region-mismatch`). With a member who wraps a version of the page under another share's key, it can show the page in that share, and new sessions there go under that share's keys, as a draft save would (A2).
- **A malicious member** (an editor):
  - **Writing.** They can type anything, as they can save anything today. They can't write under another person's Yjs client, since client IDs come from the sender's identity and join, and they can't sign as anyone else.
  - **Snapshots.** They can post a snapshot whose history differs from the session's. Newcomers check its text and state against a signed revision, and that it claims no more of anyone than their latest signed change, so it can't show them other text or make them skip someone's later typing. It can give the earlier text other places in Yjs's history, so later typing by others lands differently for the newcomer than for the rest. Everyone then sees different text until a save, after which they see the difference. That is confusion, not disclosure, and the member could as well delete the text. It can name an unsigned position that gets the server to delete changes it doesn't hold, so newcomers can't catch up: availability only.
  - **Saving.** As the saver, they can save text that leaves out someone's paragraph while its `state` claims to hold it. The writer's app counts its typing saved only when its own document holds the draft's state, so a draft claiming a change the saver never sent isn't taken as saved, and is out of step once 30 s pass with the saver connected. A draft that leaves the paragraph out with a state the writer does reach is caught at the next moment their states match. Either way the writer's app leaves the session and meets the conflict, and **Merge…** shows the difference (decision 5). If the session ends between the save and that moment, the paragraph is gone, as if they had deleted it in the open, and the writer saw "Saving…": an app shows "Saved" only for a draft it has checked, and leaving saves its own document otherwise (decision 5).
  - **Saved notices.** They can name a position past what they saved, so the server deletes a session with unsaved changes after everyone leaves. That loses what the session typed since its last save, as deleting the text would.
  - **`with`.** They can name people falsely in `with`, which is the saver's word, not the named people's.
  - **Flooding** is for the rate limit, and for the owners to remove them.
- **A removed member.** A removal ends the session, and the next session's key is under the new key version. The removed person can read only what the old session relayed before the end (A3). A server that keeps the old session open after a rotation, colluding with the removed person, reaches only apps that don't know of the rotation (A2): an app that holds the new key version, or no longer counts the removed owner as a sealing owner, refuses the old session and leaves it if it was in it (decision 4).
- **Attribution** (section 2.3, authenticated authorship). Each change is signed by its writer, but changes aren't kept after the session. A draft revision's signature now says who saved it, and the revision may hold other people's typing. History says so (decision 5).
- **Agents** don't join, and apps refuse messages from an agent's identity. An agent revoked or made a reader still holds the draft keys it had (A6, Q10), so, colluding with the server, it can open a session under those key versions and read every keystroke, text deleted before any save included, as it can read drafts saved under them. It can't write into the session.
- **Served JavaScript** (A9) is as before: the code that edits live is the code that saves.

## Spike evidence (2026-11-12)

A throwaway spike (`~/.cache/wikistow-tmp/adr-live-editing/spike/`, not committed) used Yjs 13.6.33 and libsodium-wrappers-sumo 0.8.4 on Node 26, on the first 5, 60 and 200 KB of `wikistow.md`. Each typist types 6 characters a second nonstop, with 12% backspaces and a jump to a random place now and then. Changes are merged and sealed every 100 ms with XChaCha20-Poly1305, hashed and signed with Ed25519, then checked, opened and applied by every other typist. Times are per change.

| Page | Typists, time | Seal | Check and open | Apply | Changes | Snapshot, start to end | Opening it | Replaying all changes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 KB | 2, 10 min | 0.16 ms | 0.38 ms | 0.03 ms | 7,451 | 5 → 72 KB | 15 ms | 1.7 s |
| 60 KB | 2, 10 min | 0.17 ms | 0.38 ms | 0.04 ms | 7,451 | 60 → 128 KB | 13 ms | 1.5 s |
| 60 KB | 2, 60 min | 0.16 ms | 0.37 ms | 0.03 ms | 44,849 | 60 → 474 KB | 50 ms | 8.9 s |
| 200 KB | 4, 10 min | 0.16 ms | 0.25 ms | 0.03 ms | 14,925 | 200 → 400 KB | 28 ms | 3.1 s |

- Every run converged: each typist's text was the same at the end.
- A change is about 26 bytes of Yjs update, so its seal, signature and IDs make up most of the roughly 300 bytes it takes on the wire. An hour of two people typing nonstop is 11 MB of changes, which is why newcomers start from a snapshot.
- The snapshot grows with what was edited, not with the page: backspaces split Yjs's runs of text. Starting a session from a revision starts it small again.
- Turning a rewritten block into the smallest change in characters, over the whole text, took 4.5 to 9.6 ms on 10 to 212 KB.
- Yjs takes 53-bit client IDs, and a receiver can list the client IDs an update adds to, which the derived client IDs need (decision 4).
- **The visual editor today**, in a throwaway browser test in Chromium through `vp test`, three runs, on pages cut from `ui-design.md` that it reads back the same. For each, the time to check fidelity of the whole page, to check one block with the blocks either side of it, and for `show` to put in someone else's change to one paragraph:

  | Page | Whole-page check | Three blocks | `show` |
  | --- | --- | --- | --- |
  | 5 KB | 0.55 s, with the first load | 9 ms | 33 ms |
  | 60 KB | 0.69 to 0.74 s | 23 ms | 160 to 185 ms |
  | 100 KB | 0.95 to 0.98 s | 6 to 7 ms | 230 to 280 ms |
  | 200 KB | 2.1 s | 36 to 38 ms | 460 to 467 ms |

  So putting each change from someone else in through today's path would hold the visual editor for about 0.9 s at 60 KB, and 2.5 s at 200 KB. Replacing just the touched nodes isn't measured yet: step 2 measures it.

## Considered options

- **Operational transforms with a central server** (Google Docs, `@codemirror/collab`). The server orders and transforms every change, so it has to read them. End-to-end encryption rules that out.
- **A CRDT over the visual editor's document** (`y-prosemirror`). It keeps rich structure, but only the visual editor could take part. Pages the visual editor can't read back the same would stay out, and the shared document wouldn't be the page's Markdown, so every save would write it out again in the editor's style.
- **Automerge or Loro.** Both would work. Yjs has the CodeMirror binding, the most use, and compact updates. Its update format has stayed the same through 13.x.
- **Every app saves.** That gives twice the saves, and the apps in a session conflict with each other at every one. A single saver keeps today's one save a second per page.
- **Each change its own record**, with its own key wrap. That is heavier, and the server's checks run at every keystroke. One session key, sealed like a comment for editors, gives the same audience.
- **A session key derived from the share's draft key.** The owner region has no folder key, and it would be a new use for a key that wraps nothing else.
- **The Yjs document in the revision.** Every revision and history would carry the session's structure, and publishing would have to remove it.
- **Refusing writers outside the session while it is open.** An agent could never write while anyone had the page open, and an older app would meet the conflict prompt in a loop. Folding in what lands keeps today's rule for them.
- **Taking an outsider's save based on any recent draft of an open session**, which the saver merges anyway. Agents could then write while people type. But the head would hold, until the fold, a draft without what the session typed since, and #321 keeps the conflict for writers outside. Decide 5.
- **Stopping the session's saves until someone merges an outsider's change.** People typing would go unsaved while nobody reviews. The session's text stays, and the outsider's version stays in the checkpoints.
- **WebSockets.** One connection per tab would replace a request per change. But it needs a new server dependency, a policy change, and a way around the desktop app's protocol handler, which can't carry one. The NDJSON stream and the requests reuse what the other streams do. Decide 7.
- **One stream per tab for everything** (tree, comments, live). That means fewer connections, which matters over HTTP/1.1, where a browser allows six per server across tabs. A deployment can serve HTTP/2 at its TLS proxy, though nginx, which `docs/operations.md` names, needs it turned on (`http2 on`). Once this is built, that file says to. Each visible tab with a draft open holds three streams, so over HTTP/1.1 two windows use up the browser's six; the browser app therefore joins sessions only over HTTP/2 or later (decision 10). This can come later.
- **Sessions only when a second editor comes.** That saves a snapshot upload per draft opened. But editing online would work two ways, and the first person's app would have to hand over what they were typing when someone came. Decide 2.

## Consequences

- **Now, with this ADR:**
  - `wikistow/protocol.md` gains section 5.10, **Live sessions**, and the `wikistow.live` and `wikistow.overlaps` extensions in section 5.5, with notes in sections 1, 2.4 (A7) and 3.5 (three new domains), all marked proposed.
  - `protocol-review.md` logs it.
  - `wikistow.md`'s line on later work points here, `ui-design.md`'s page views say where presence goes, and `CONTEXT.md` gains **Live session**, all marked proposed.
- **Once accepted:** a protocol review round (section 18) runs on section 5.10 before any client code that seals or opens messages.
- **Once built:**
  - `wikistow.md` gains a Live editing section, and its Drafts section says that a draft's author is who saved it.
  - `ui-design.md` gains presence in the toolbar, carets, the fold note and **Review**.
  - `wikistow.md`'s Drafts section says which drafts a session reads after they are saved over, and that retention keeps them while the session lasts.
  - ADR 0009 decision 7 says how a queued change for a page in a session is withdrawn.
  - The agents guide says that pages being edited live change every second.
  - `docs/operations.md` says to serve the app over HTTP/2 at the proxy (for nginx, `http2 on`), since each tab with a draft open holds one more stream.
- **Code.**
  - The server gains session tables and a migration, the routes of decision 13, the stream, ending sessions when permissions move, and deletion.
  - `packages/client` gains a `live` module: the session record, messages, client IDs and the snapshot check.
  - `packages/ui` gains the Yjs document in the draft session, the source binding, the visual editor's block map and the way it takes in others' changes, the saver, presence and the fold.
  - `yjs` and `y-codemirror.next` become dependencies, loaded with the editor.
- **Attribution.** A draft revision made in a session is signed by the app that saved it.

## Implementation, in pull requests

1. **This ADR, the spec and the protocol.**
2. **The visual editor by block.** Map each top-level node to its source, so unchanged blocks keep their source, and take new text in by block in place of the whole-page `show`. This is useful alone: no restyling of blocks nobody edited, and split mode gets cheaper on large pages. Measure the read of a touched block at 60, 100 and 200 KB.
3. **The protocol review** of section 5.10, once the decisions are made.
4. **The server.** Tables, the routes, the stream, ending on any permission change, deletion and retention. Integration tests: a reader or an agent can't fetch a session or join it; a removal ends it; it is deleted after everyone leaves, and kept while its last change is unsaved; and the content-leak sweep finds nothing.
5. **The client's `live` module.** The session record, sealing and opening messages, client IDs, the snapshot check, and test vectors for the three domains.
6. **Editing live in source mode.** The Yjs document in the draft session, the CodeMirror binding, the saver, Saved, presence in the toolbar and carets. E2e with two browser contexts typing into one page: both see both, one draft history, and nobody gets a conflict.
7. **The visual editor in sessions, and writers outside them.** Others' changes by block, the switch to source mode, the fold with **Review**, offline and resuming, the chat assistant's and plugins' changes. E2e: an agent's save during a session is folded in, and an overlap offers **Review**.

Steps 2 and 4 can run in parallel. Step 5 needs step 3, and step 6 needs steps 4 and 5. Step 7 needs steps 2 and 6.

## Decide

1. **A CRDT (Yjs) over the page's text, with both editors?** Recommended: yes (decisions 2 and 3). Operational transforms need a server that reads the changes, and a CRDT over the visual editor leaves source mode out.
2. **Every editor joins when they open the draft, alone too?** Recommended: yes (decision 1). One way to edit online, at the cost of a snapshot upload per draft opened. The other way, starting when a second editor comes, adds a hand-over while the first person types.
3. **One saver, the visible participant listed longest, saves and signs the drafts?** Recommended: yes (decision 5). If every app saved, they would conflict with each other at every save.
4. **The session record as a metadata record v2 with `subjectKind: "live"`, plus three new domains for messages?** Recommended: yes (decision 4). The session key reaches exactly the draft's audience through the keys that already exist.
5. **Writers outside the session keep `stale-head`, and a save of theirs that lands is folded in, with the session's text winning where they overlap and Review offered?** Recommended: yes (decision 8). Refusing them while a session is open would block agents whenever anyone had the page open. Even so, an agent that takes longer than the gaps between people's pauses rarely lands a change while they type. The server could instead take an outsider's save based on any draft of the open session, which the saver merges anyway, at the cost of the conflict #321 keeps for them.
6. **Presence: names in the toolbar, carets in source mode, a bar by the block in the visual editor?** Recommended: yes (decision 7). Exact carets in the visual editor can come later.
7. **An NDJSON stream and requests, not WebSockets?** Recommended: yes (decision 4). They reuse the streams the server has, and the desktop app forwards them as it is.
8. **A session ends at any change of access to the page?** Recommended: yes (decision 12). It is simple and safe. Only a removal or a change to reader needs a new key, and both rotate the share's keys, but a member added or another role change restarts the session too: a pause of a second or so, and **Merge…** for two people who typed in one block in its last tenth of a second.
9. **History names who else wrote (`with`)?** Recommended: yes, for editors (decision 5). The signed author stays the saver.
