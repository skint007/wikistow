---
status: accepted
---

# Comments on pages

People want to ask a question about a page, or suggest a change, without editing it (#320). Today they edit the page or talk outside the wiki. This ADR decides how anyone who can read a page comments on it, end-to-end encrypted like the page: who can comment and who reads what, which keys seal a comment, what a comment points at, threads, and what moves, shares, copies, public links, the trash, offline, agents and the CLI do with comments.

In short:
- **Anyone who can read a page can comment on it,** readers included. A comment made while reading the page is **for readers**: everyone who can read the page reads it. One made in the draft view is **for editors**: only the page's editors and owners read it. Replies go to the thread's own audience.
- **No new keys.** A comment is sealed like a version of its page, under the keys of the page's region: in a share, a comment for readers under the share's published key and one for editors under its draft key, so readers never read editors' comments; outside shares, to the owners.
- **No new record format.** A comment is a metadata record v2 with `subjectKind: "comment"`, as a group's name is. Its encrypted payload names its page, its thread, its audience, and the passage it is on, if any. No new domain strings.
- **A comment belongs to the page,** not a version. It may point at a passage, by the text it quotes. When that text changes, the comment says so and keeps its quote.
- **Threads** of one level, with replies. The thread's starter or the page's editors resolve it. Authors edit their own comments; authors and the space's owners delete them.
- **Telling people** stays in the app: a count and a dot on the page's **Comments** button, and a **Comments** list in the rail of threads with something new for the person. No mail.
- **Comments go where their page goes** within a space, rewrapped with its versions. Copies, publications into other spaces and public links never carry them. A move into another space deletes them with the source page. Offline, they need the connection.
- **Agents and the CLI** list and add comments, as themselves, for readers only where they can publish.

## What the code supports today

- **There are no comments.** `wikistow.md` says comments are later work (#320). No table, route or interface exists.
- **Readers write nothing.** Every write route needs edit rights at the node. Changes made while reading (ADR 0008) need an editor who can publish, and are published versions. So a reader's app has never chosen a key version to write under.
- **Key classes** (`AudienceClass` in `packages/contracts/src/records/share.ts`): `draft`, `published` and `metadata`. Readers hold only published keys, editors and owners both (protocol sections 6.2 and 7.1). Outside shares, the owners hold every content key (section 6.6).
- **Metadata records v2** (`packages/contracts/src/records/metadata.ts`) take `subjectKind` `space`, `folder` or `group`. A group's name was added as a new `subjectKind` with no new domain strings (protocol section 1, **What Milestone 5 adds**). An app from before it refuses one strictly, and so can't scan an owner region that holds one until it updates.
- **The scan route** (`GET /api/spaces/:spaceId/records`, `records` in `packages/contracts/src/routes/sharing.ts`) lists records of kind `revision` or `metadata`, strictly parsed. Making a share, a move across a region boundary, ending a share and adding a co-owner all use it, and the server checks that their key material covers every record it lists.
- **Pinning** happens the first time an app verifies a record someone wrote (protocol section 8.3), so readers already pin the editors whose versions they read.
- **The page's side column** holds the chat: a 380px card after the page card on windows 1200px and wider, otherwise a sheet from the right (`wikistow/ui-design.md`, Page chat).
- **The live tree** (`GET /api/me/tree-changes`) streams `{spaceIds}`, a strict object, from Postgres `NOTIFY`.
- **Mail** goes out only for accounts: invitations, password resets and email changes (`apps/server/src/mail/mailer.ts`).
- **Copies** bring a page's current draft and published version and nothing else (protocol section 10). A **public link's copy** holds the published title, body, cover and the files they show (ADR 0005, decision 1).
- **The CLI** has `page` subcommands (`page history`, `page move`, …), and `wikistow mcp` offers each command as a tool (`page history` is `page_history`).

## Decisions

### 1. Who comments, and who reads what

- **Anyone who can read the page comments on it**: readers, editors, publishers, owners, and agents within the limits of decision 10. Readers asking questions is the main use, so leaving them out would miss the point of #320.
- **Two audiences, from the two key classes there already are.**
  - A comment **for readers** is made from the published view. Everyone who can read the page reads it: its readers, editors and owners. It needs the page to be published.
  - A comment **for editors** is made from the draft view. Only those who can read the draft read it: editors, publishers and owners. Readers never see it, nor that it exists.
- **The audience follows the view,** so nobody chooses: the box says which it is ("Comment for everyone who reads this page", or "Comment for editors"). A reply takes its thread's audience, wherever it is written, so a reader always sees the answer to their question. The writer's app takes that audience from the first comment it opened, never from the server, and offers no **Reply…** under a first comment it can't open or read, one written by a newer app included. The reply box says its audience too ("Reply for everyone who reads this page").
- **Editors see every thread** in both views. A thread whose audience isn't the view's is marked: **Editors** in the published view, **Readers** in the draft view.
- **Unpublishing** hides the comments for readers from readers, as it hides the page (protocol section 11). As with history, readers then see only threads started since the latest unpublish, so a quote from a version an unpublish withdrew doesn't come back to them. Editors still see the older threads, marked "From before the page was unpublished", with no **Reply…**, since no reader would see a reply; the server refuses one. While the page is unpublished, threads for readers take no replies either.

### 2. Keys: the page's region, by audience

A comment is sealed as a version of its page is, under the keys of the page's region (protocol section 6.1):

| Region | For readers | For editors |
| --- | --- | --- |
| In a share | content key wrapped with the share's **published key** | content key wrapped with the share's **draft key** |
| Owner region | v2 envelopes to the sealing owners | v2 envelopes to the sealing owners |

So a comment for editors needs the draft key, which readers never hold (section 6.4), and readers can read comments for readers and write them: they hold the published key. In the owner region only owners read the page, so both audiences go to the owners, and the audience matters once the folder is shared.

Each comment version has a fresh content key, wrapped under the share's current key version, with the key version check of section 6.8 and the **No going back** mark. A reader's app now chooses a key version to write under, by the same rule as any writer's: the highest it holds whose envelope an accepted owner it hasn't removed sealed (section 6.5, **Writing**).

### 3. The record and the payload

**The record** is a metadata record v2 (protocol sections 5.4 and 5.7) with `subjectKind: "comment"`, `subjectId` the comment's ID (`newId`), and `metadataRevisionId` the ID of this version. The first version has `basedOn: null`, and an edit is based on the current version. It is signed by its author.

**The key material** is a key wrap (section 6.3) with `audienceClass` the comment's audience (`"draft"` or `"published"`, never `"metadata"`), `subjectKind: "comment"`, `subjectId` the comment ID and `versionId` the version ID; or, in the owner region, v2 metadata envelopes (section 5.8).

**The payload**, comment format 1.0:

```
{ format: {major: 1, minor: 0}, pageId, thread: CommentId | null, threadAuthor: IdentityId | null,
  audience: "draft" | "published", text: string,
  quote?: { revisionId, exact: string, prefix: string, suffix: string },
  extensions: { [namespace]: JSON } }
```

- `pageId` is the page it is on, and `thread` the thread's first comment, or `null` for a first comment. `threadAuthor` is that first comment's signed author, as the writer's app opened it, or `null` for a first comment. `audience` is its audience: `"published"` for readers, `"draft"` for editors.
- `text` is 1 to 10,000 characters of Markdown, any well-formed text, line breaks, tabs and right-to-left marks included.
- `quote` is the passage, if any (decision 5). The payload and the quote are loose: an edit keeps fields it doesn't know, as page payloads do.

**Why the payload binds the page, thread and audience.** The signed record has no field for them, and the payload is bound to the author's signature through `payloadHash` and `keyCommitment`. So a server that serves a comment on another page, in another thread, or for another audience is caught when the app opens it (decision 4), with no new signed layout. That is how the group's name was added, and it keeps the frozen domains as they are. A new `comment-record/v1` would sign these fields in the record, but would need its own payload AD and envelope domains too (see **Considered options**, Decide 3).

### 4. Writing and opening

**Writing a comment.** The app opens the page's version on screen anyway, and takes the comment's region from it, as section 6.1 does for a write with `basedOn: null` on an existing page: the region of the draft it opened, otherwise of the publication. An edit is in the region of the version it is based on. It sends the comment with the page's permission version. The server checks, under the same locks as a save:
- the caller can read the page for the comment's audience: for readers, the page is published and the caller can read it; for editors, the caller can edit the page; an agent within its grant and its person's access (section 9.5), and for readers only where it can publish (decision 10). Editing, deleting their own comment and resolving need the same access now, so a removed or demoted person no longer acts on threads they can't read; only an owner's delete doesn't;
- the request's record is a comment's v2 record for the comment ID it names, with `basedOn: null` for a first version (`invalid-request` otherwise);
- the key material is what section 6.8 requires in the page's region, at the current key version, and the permission version is current;
- a reply's thread is a first comment on the same page, for the same audience as the request names, and not deleted;
- the comment and version IDs are new, and comment version IDs and metadata version IDs are one set, checked both ways, so a folder's new name can't take a comment version's ID either (`duplicate` otherwise, which also covers a request sent again after a lost answer);
- the sealed payload's ciphertext, decoded, is at most 65,536 bytes (`payload-too-large`), and the caller is within a rate limit. The largest valid payload seals to about 64,100 bytes;
- for a reply for readers, that its thread was started since the page's latest unpublish (decision 1).

The server can't read the payload or open the wrap, so it can't check a comment's audience, page or thread itself. It records the audience and thread the request names, never changes them, and serves the comment by them; the app that opens it checks them.

**Opening a comment** runs the checks of a metadata record v2 (sections 5.4, 5.7 and 6.3), asking for `subjectKind: "comment"` and the comment's ID, then:
1. the comment's key material is in the region of the page's version the app opened: a wrap under the same share, or envelopes in the owner region (`region-mismatch` otherwise), so a member can't put a comment, wrapped under the keys of a share they are in, on a page elsewhere;
2. the wrap opens with the AD for the audience the server lists for the comment; in the owner region, the envelopes are granted by an accepted owner;
3. the payload parses as comment format 1.0 (a newer major format shows as "Update the app to read this comment"): `thread` and `threadAuthor` present, `null` or IDs, a `quote` absent or an object, and none on a reply;
4. `pageId` is the page the server lists the comment on, `thread` is the thread it lists (`null` for a first comment), and `audience` is the one the wrap opened under (in the owner region, the one the server lists). Otherwise `binding-mismatch`. In a share, the wrap's AD already authenticates the audience, so a reply needs no check against its first comment for that, which may be deleted;
5. while its first comment is there and opens, a reply's `threadAuthor` is that comment's signed author (`binding-mismatch` otherwise). So a server, with a member who signs a new first comment under the thread's ID, can't make other people's answers look like answers to that member's question.

A comment that fails shows in its place as "This comment can't be opened", so a thread stays whole. Its author is the record's signed author, shown by the pinned label (section 8.2), or as "agent (for person)" (section 9.5).

**Rendering.** The text is Markdown read as the reader reads a page, without raw HTML, images, embeds, plugin blocks, query tables or diagrams, with task boxes drawn but never live, and with property references and claimed inline code shown as the plain code they are, so a comment loads nothing, runs nothing, and never shows a value from the viewer's own index under its author's name. Links and wikilinks work; a wikilink resolves by title in the viewer's own tree, since a comment has no link table.

### 5. The page, not a version; passages by quote

A comment belongs to the page. It stays through edits, publishes and restores, and shows on every version.

A comment may point at a **passage**: the person selects text in the app's own reader in the published view, or in the visual editor in the draft view, and presses **Comment**. The button never shows over a plugin's view, such as a plugin that replaces the page's text as read (ADR 0011), where the app can't tell what the selection is in the page's own text (below). The payload keeps the passage as text, not as a position:
- `exact`: the text selected (1 to 500 characters), as the page's own text reads, with a line break between blocks;
- `prefix` and `suffix`: up to 64 characters of that text before and after it, to tell repeats apart, cut between characters, never inside one;
- `revisionId`: the version it was made on, a version of the comment's page.

**The page's own text** is what the body says by itself, the same for every viewer: its words as the reader shows them, but with everything the app or a plugin draws from outside the version counted as its source as written. That is wikilinks (a link without its own text shows its page's title from the viewer's own tree), embeds, property references (`` `=servings` ``, `` `=[[Page]].key` ``), query tables, plugin blocks and claimed inline code, diagrams and math, and anything else drawn from outside the version. A viewer sees titles and values of their own there, from drafts for an editor and from pages others can't open (ADR 0006, protocol section 5.5), and a quote, whose context the person never sees, must not carry them to the comment's audience. A selection that covers such a part takes its source. A quote is clipped to the body: the title, properties, **On this page** and **Linked from**, which shows titles from the viewer's own index, are never in it.

This is the W3C Web Annotation text quote selector, which Hypothesis uses. A position would break with the first edit above it. Only a first comment has a quote. A reply has none, so text selected in the draft view never rides along in a reply to readers. A quote belongs to the view it was taken in: its version is one of the comment's audience (a published version for readers; for editors, the draft, which the app saves first so the version holds the text quoted), and it stays with that view's unsent comment (decision 13). When the comment is first sent, and again before every retry, a quote for readers must name a version readers can see now, one since the page's latest unpublish; otherwise the app drops the quote and says so, so a passage an unpublish withdrew never comes back through a comment started before it, even one sent again after the unpublish refused it as `permission-version`. An edit keeps its quote as it was.

The app finds the passage in the version on screen by its text: `exact` where `prefix` and `suffix` fit best, or else its first match. Found, the passage is underlined in the published view, and the thread sits beside it. **When the text it points at changes** so that `exact` isn't there any more, the thread stays, marked "This passage isn't in the page now", with its quote shown as part of the comment. The app doesn't claim the quote was ever there: its author wrote it. Its starter or an editor resolves it once it is dealt with. **Made on version N** opens the version it names, for anyone who can open that version, and only when its signed record is of the comment's page.

In the draft view, a thread on a passage shows its quote, and **Show** selects the passage in the editor when it is still there. The source editor makes comments on the page only, since its selection holds Markdown markers rather than text as it reads.

### 6. Threads, resolving, editing and deleting

- **Threads have one level.** A first comment starts a thread; replies follow it in order. There are no replies to replies.
- **Resolving** folds a thread away. The thread's starter (for a thread an agent started, the agent's person), or anyone who can edit the page, resolves it or opens it again, and a new reply opens it again. Resolving is server state, `resolvedAt` and `resolvedBy`, not signed: it changes nothing anyone reads, and the server already decides who sees what (A1).
- **Editing.** Only a comment's author edits it, by a new version based on the current one (`stale-head` otherwise), with the same page, thread, audience and quote: the server keeps the thread and audience it recorded, and the app checks the payload against them when it opens the comment. The server keeps only the current version, so there is no edit history, and the comment shows "edited", which the app takes from the signed record (its `basedOn` isn't `null`), not from the server's times. Anyone who read the old text keeps it (A3).
- **Deleting.** A comment's author, and the space's owners, delete it; for a comment an agent wrote, the agent's person counts as its author. Like the starter's resolving, an author's delete needs them to read the comment's audience on the page still (decision 4). It goes for good, with its key material. A first comment that has replies leaves "Comment deleted" in its place, until its last reply goes too, and its thread takes no new replies. Nobody else deletes others' comments: owners are the moderators a family space needs.
- **Order.** Open threads go in the order of their passages in the page, which the app works out as it finds them, then threads on the whole page and those whose passage isn't found, oldest first; resolved threads fold under "2 resolved" at the end. What is oldest, and the order of a thread's comments, go by the server's times, which nothing signs, as history's order (Q5).

### 7. Where comments go when their page goes

A comment's current version is a **retained record of its page**. Every operation that covers every retained revision and metadata version of a subtree covers it too:

- **Making a share** (section 6.7) wraps each comment under version 1, by its audience. The share preview's line about history, here, when someone is added to a share (section 7.3), and when a reader becomes an editor, directly or through a group (section 7.4), says members also get the comments for them: readers those for readers, editors all.
- **A move across a region boundary** (section 10) rewraps them with the page's versions. A move within one region changes nothing.
- **Ending a share** (section 6.9) seals them to the owners with the rest. **Adding a co-owner** (section 7.6) seals the owner region's comments to them.
- **A rotation** rewraps nothing, as for versions. New comments go under the new key version, so a removed person reads none written after it.
- **The owner's app opens each comment before it wraps it, and takes its audience from what it opened**, never from the server. So the scan route serves each comment with its payload and the page, thread and audience the server records (decision 12), and the app opens it as in decision 4. Through a share's wrap, the audience is the one the wrap opened under; in the owner region, the one in its payload. A server that lies about a comment's audience can't get an editors' comment wrapped under a published key: the wrap fails to open, or the payload says `"draft"`. The comment's page must also be one of the pages the scan lists, in every scope, and its key material in the region of that page's records in the same scan, which stands in for decision 4's version on screen. For making a share, the owner also sees those pages in the preview. So a server can't slip in a comment from a page outside the folder or the share without also misplacing that page, as it could misplace a page's versions today (protocol section 14.3).
- **A comment that can't be opened** stops the operation, as an unopenable version does (ADR 0012, decision 4), but costs less to get past: the app names its page and offers **Delete comment**, which owners may do, for a page in the trash too, and then goes on. So a reader's broken comment, made by a bug or on purpose, holds up a share or a move only until an owner presses it. A comment in a newer major format stops it too: the app says to update, names the page and the comment's author, and offers **Delete comment** as well, since any member can write one, and never takes its audience from a payload it can't read. Owners' **Delete** in the panel works on every comment, opened or not. A comment edited or deleted between the scan and the request makes it `stale-head`, as a version saved meanwhile does, and the app scans again.
- **The trash.** A page in the trash takes its comments with it, hidden like the page. Restoring brings them back, and its check that every record fits where it goes (protocol section 10, **The trash**) counts them; deleting it for good, emptying the trash, the 30-day sweep and **Delete space** delete them.
- **Copies.** A copy, of kind `copy` or `move` (section 10), brings none, as it brings no earlier version. A move into another space deletes them with the source, and its line about what it ends names comments with earlier versions. An older app's move says nothing of comments, since it doesn't know of them (decision 11). They can't come along: a copy is sealed again by the person copying, and their signature would replace each commenter's.
- **Publications into another space** (section 13) carry none. The destination page has comments of its own, from its own readers.
- **Public links** never carry comments: the public page has none, and no comment is ever stored readable.
- **Unpublishing** hides comments for readers from readers (decision 1); **restoring a version** changes nothing.

### 8. Telling people

- **On the page.** The **Comments** button in the page's toolbar shows how many open threads the person can see, with a dot when any has a comment from someone else since they last opened the page's comments.
- **In the rail.** A **Comments** item, with the same dot, opens **New comments** (`/comments`): threads with a comment the person hasn't seen, from someone else, that concern them. Those are threads they started or replied to, and, on pages they can edit, new threads. Each row shows the page's title, who wrote, when, and the first line, which the app decrypts. To show the title it opens the page's current version, as the sidebar does, and it checks each comment against that version as decision 4 does before showing it. Opening the page's comments marks that page as seen.
- **Seen marks** are kept on the server, one time per person and page, so they follow the person to every device. The server knows who wrote each comment and when already; it now also knows when each person last read a page's comments (A7).
- **Live.** A stream of its own, `GET /api/me/comment-changes`, names the pages where a comment the person can read was added, edited, deleted, resolved or opened again, from Postgres `NOTIFY` as the tree's is. The tree's stream sends a strict `{spaceIds}`, which released apps parse, so comments don't join it.
- **No mail.** The server can't read the comment or the page's title, so mail could say only that there is something new. That is a later choice, as a daily summary each person turns on, holding nothing but the count and a link to **New comments** (Decide 6).

### 9. Offline

Comments need the connection at first. Offline, the **Comments** button says "Needs the connection" (ADR 0009, decision 8), and nothing about comments is kept or queued. A device that keeps a page for offline (ADR 0009, decision 1) keeps no comments, so A13 doesn't change. Keeping and queueing them later would follow ADR 0009: kept sealed like any item, and sent when back online, under the keys of that moment.

### 10. Agents, the CLI, export, search and plugins

- **Agents** read comments within their grant and their person's access (protocol section 9.5). They add comments for editors where they can edit, and comments for readers only where they can publish, which the server checks as for a publish: before comments, an agent without publish rights could put nothing in front of readers but folder names and looks, and a reader's comment asking it to shouldn't change that. So an agent with a reader's grant reads comments and writes none. They comment as themselves, shown as "agent (for person)". They don't edit, delete or resolve, their own comments included: the server refuses them. Their person, who counts as the comment's author, or an owner deletes a comment an agent wrote. A chat assistant neither reads nor writes comments yet: its changes are proposals, and comments aren't among them, and what it reads goes to the AI provider, which the assistant's notice names for pages only.
- **The CLI.** `wikistow page comments <page>` lists the page's threads and comments: ID, audience, author, time, quote, resolved and the text, as text and with `--json`, under the foreign-text rules (section 9.3). `wikistow page comment <page> --text TEXT --for readers|editors [--reply-to ID]` adds one. `--for` is always required, so an agent never writes to readers by default, nor answers a reader's thread without naming whom it answers. A reply takes its thread's audience, from the first comment as the CLI opened it, and the CLI refuses a `--for` that differs; `page comments` lists each thread's audience. `wikistow mcp` offers both, as `page_comments` and `page_comment`.
- **Export** leaves comments out. A Markdown export is the pages as written; comments would need a format of their own.
- **Search** doesn't index comments.
- **Plugins** have no comments API. The comments panel isn't a replaceable region (ADR 0011).

### 11. Older apps

Released apps never ask for comments, so they never see one, with one exception: the scan route serves comments to the owner operations that cover a subtree, and an older app would parse that answer strictly and refuse it, saying only that the server's answer didn't make sense. So the scan lists comments only to an app that asks for them, with `comments=1`, and answers an app that doesn't, over a scope that holds comments, with `invalid-request`, which released apps show as "Update the app and try again". So until it updates, an older app can't make a share, move across a shared folder's edge, end a share or add a co-owner where a page has comments, and says to update. That fails closed, as a group's name did in Milestone 5: an older app that skipped comments would leave them under keys the new region doesn't use. Everything else works: reading, editing, publishing, moves within a region, copies and deletes. One loss comes without a word: an older app's move into another space deletes the source's comments, as a move does, but its line about what the move ends doesn't name them. The CLI never scans, since agents can't cross regions.

A newer app on an older server, as when the desktop app updates before the family's server does, finds no comment routes: the comments route answers `not-found` for a page the app has just opened. The panel then says "This server needs an update for comments" and offers nothing else, and the CLI says the same.

### 12. Routes

New routes only; no existing response gains a field.

| Route | Does |
| --- | --- |
| `GET /api/pages/:pageId/comments` | The page's threads, each comment with its record, payload and the caller's key material (a wrap, or their own envelopes), its thread, its audience, its author ID, when it was made and edited, and for a first comment whether it is resolved, by whom, whether it was deleted, and, for editors, whether it was started before the page's latest unpublish (decision 1). Only what the caller can read: comments for editors only to those who can edit the page. Also the caller's seen time. |
| `POST /api/pages/:pageId/comments {commentId, thread, audience, metadata, wrap \| envelopes, permissionVersion}` | Adds a comment (decision 4). |
| `PUT /api/comments/:commentId {metadata, wrap \| envelopes, permissionVersion}` | Its author edits it. |
| `DELETE /api/comments/:commentId` | Its author (for an agent's comment, the agent's person) or an owner deletes it. |
| `POST /api/comments/:commentId/resolve {resolved}` | Resolves or opens a thread. |
| `POST /api/pages/:pageId/comments/seen` | Marks the page's comments as seen now. |
| `GET /api/me/comments` | **New comments** (decision 8): `[{spaceId, pageId, thread, count, latest}]`, only threads the caller can read, `count` the comments they haven't seen and `latest` the newest of them, as the page's route serves a comment, so no second request for the comment is needed; the app still opens the page's version to show its title and check the comment (decision 8). |
| `GET /api/me/comment-changes` | The stream (decision 8): `{pageIds}`, only for changes to comments the caller can read. |
| `GET /api/spaces/:spaceId/records` | With `comments=1`, gains entries of kind `comment`, each with its record, payload, key material, and the page, thread and audience the server records, in every scope that covers their page. Without it, a scope that holds comments is `invalid-request` (decision 11). |

The requests that rewrap or seal a subtree (making a share, a move across regions, ending a share, adding a co-owner) carry comments' key material in fields of their own, which older apps never send: wraps with `subjectKind: "comment"` among the others, and `commentEnvelopes`, v2 metadata envelopes for comment versions, beside `metadataEnvelopes`. The server's coverage check counts them. Since comment version IDs and metadata version IDs never repeat each other, an envelope names one record, and the server stores a comment's wraps and envelopes under a kind of their own, `comment`, never with names'. The audit log records `comment.deleted` when an owner deletes someone else's comment, with IDs only.

### 13. Where it shows

**The button.** **Comments** (a speech-bubble icon with the count) sits in the page's toolbar beside **History**, in both views, for everyone who can read the page. Offline it says "Needs the connection".

**The panel** takes the chat's place: a 380px card beside the page card on windows 1200px and wider, otherwise a sheet from the right, the whole width on phones. Opening one closes the other. At the top, the box for a new comment on the page, which says its audience; **Comment** (or Ctrl+Enter, Cmd+Enter on a Mac) sends it. Each page and view keeps its own unsent comment, text and quote: switching views shows the other view's box, going to another page shows that page's, and what was typed in one never moves to another, whose page or audience differs. An unsent comment is kept in memory only, and goes when the app locks or signs out. No comment, reply or edit box offers link, title or property completion, which would offer titles and values from the writer's own tree and index, drafts and other regions included. Then the threads (decision 6). Each comment shows its author, when, and its text, with "edited" when it was. A thread on a passage starts with its quote, dimmed. Under a thread, **Reply…** opens a one-line box, which says its audience. A comment's ⋯ menu has **Edit** (its box says its audience, as the reply box does) and **Delete** for its author, and **Delete** for owners. A thread has **Resolve** (✓) for its starter and editors. A thread whose audience isn't the view's has a pill: **Editors** in the published view, **Readers** in the draft view.

**A passage.** Selecting text in the app's own reader in the published view, or in the visual editor, shows a small **Comment** button above the selection; on phones, above the browser's own selection menu, which the app can't add to. It opens the panel with the quote above the box. Passages with open threads are underlined in the published view; clicking one opens its thread.

**New comments** (`/comments`): rows grouped by space, newest first, each opening the page with its thread. The panel links to it too, so a plugin that replaces the rail (ADR 0011) doesn't hide it.

```
Computer (1200px and wider)
┌───────────────────────────────────────────────┐ ┌───────────────────────────────┐
│ Lasagne          [History] [Comments 3 •] [⋯] │ │ Comments                    ✕ │
│ (Published v4)                                │ │ ┌───────────────────────────┐ │
│                                               │ │ │ Comment for everyone who  │ │
│ ## Method                                     │ │ │ reads this page           │ │
│ 1. Brown the mince with the onion.            │ │ └──────────────────[Comment]┘ │
│ 2. Bake at 180 °C for 45 minutes.             │ │ ┌───────────────────────────┐ │
│              ‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾          │ │ │ "180 °C for 45 minutes"   │ │
│ 3. Rest for 10 minutes before cutting.        │ │ │ Rita · 2 h            [✓] │ │
│                                               │ │ │ Fan oven or not?          │ │
│                                               │ │ │   Sam · 1 h               │ │
│                                               │ │ │   Fan: 170 °C.            │ │
│                                               │ │ │   Reply…                  │ │
│                                               │ │ └───────────────────────────┘ │
│                                               │ │ ┌───────────────────────────┐ │
│                                               │ │ │ (Editors) Olive · 1 d     │ │
│                                               │ │ │ Add the vegetarian one?   │ │
│                                               │ │ │   Reply…                  │ │
│                                               │ │ └───────────────────────────┘ │
│                                               │ │ ▸ 2 resolved                  │
└───────────────────────────────────────────────┘ └───────────────────────────────┘

Phone                                  Selecting text (phone)
┌──────────────────────────┐           ┌──────────────────────────┐
│ ←  Comments · 3        ✕ │           │ [Comment]                │
│ ┌──────────────────────┐ │           │ 2. Bake at ▐180 °C for▌  │
│ │ Comment for everyone │ │           │ ▐45 minutes▌.            │
│ │ who reads this page  │ │           │ (Copy · Select all)      │
│ └─────────────[Comment]┘ │           └──────────────────────────┘
│ "180 °C for 45 minutes"  │
│ Rita · 2 h           [✓] │           Text that changed
│ Fan oven or not?         │           ┌──────────────────────────┐
│   Sam · 1 h              │           │ "Bake for an hour"       │
│   Fan: 170 °C.           │           │ This passage isn't in    │
│   Reply…                 │           │ the page now. Made on v3 │
│ (Editors) Olive · 1 d    │           │ Rita · 3 d               │
│ Add the vegetarian one?  │           │ Is an hour right?    [✓] │
│ ▸ 2 resolved             │           └──────────────────────────┘
└──────────────────────────┘
```

(The editors' thread shows only to an editor; a reader sees the first thread alone, and "Comments · 1".) Rendered mockups at both sizes are in the PR.

### Out of scope

Replies to replies; mentions (`@name`); reactions; images and files in comments; mail (Decide 6); keeping or queueing comments offline (decision 9); comments from the chat assistant and plugins; exporting and searching comments; carrying comments into another space with a move.

## Threat model

Comments are content, protected as a page's versions are: the server can't read them, and no comment reaches anyone without a key for it. Section 2.3's guarantees cover them as they cover pages, and the protocol's list of content (section 2.1) and its table of what the server can do (section 2.5) name them. In particular, **readers never get draft keys**, so they never read comments for editors, and no operation wraps a comment for editors under a published key, since the owner's app takes the audience from what it opened: the wrap's authenticated class, or the signed payload in the owner region (decision 7).

- **What the server learns** (A7, extended): who commented on which page, in which thread, for which audience, when, and how long; edits and deletions; who resolved what; and when each person last read a page's comments. Never the text or the passage.
- **What a malicious server can do** (A1, A2): hide comments, show them in another order, drop replies, show a resolved thread as open, keep a deleted comment or an old version and serve it again, and delete comments. It can't write one: a comment opens only through a wrap under a folder key, or an envelope from an accepted owner, and the server holds neither. It can't move a comment to another page or thread, present a reply as a first comment, or put another person's question at the head of a thread, without the app refusing it (`binding-mismatch`), nor show a comment on a page outside the region its keys come from (`region-mismatch`, decision 4). With a member who wraps a version of the page under another share's key, though, it can show the page in that share, and new comments on it then go under that share's keys, as a draft save would (A2). A comment it says is for readers but is for editors fails to open for readers, who lack the draft key.
- **A malicious member.** Readers now write something others read. A reader's comment is signed by them and shown by their label, so it can't pass as someone the viewer has pinned (first sight, below, is the exception), and its domain and `subjectKind` keep it from opening as a page version or a folder's name. It can hold misleading text and links, as any page can; it loads no images and runs nothing (decision 4), so it can't tell its author who read it. Editors without publish rights can now put text in front of readers, where before they could reach readers only with folder names and looks (agents can't: decision 10); that is what comments are for, and the text is signed by them and shown as theirs. An editor can copy the text of a comment for editors into one for readers, as they can copy a draft; one who adds a wrap under the published key to another person's comment for editors gains nothing they couldn't get by pasting it: honest readers' apps show it as "This comment can't be opened", since its payload says `"draft"`, and owners' apps never rewrap it for readers. A member can quote words the page never held; the app shows a quote as part of the comment and never says the page held it (decision 5). A comment that can't be opened, broken by a bug or on purpose, stops an owner's share, move or ending until the owner deletes it, which the app offers at once (decision 7): availability only. Spam is for the owners, who delete it, and the server's rate limit.
- **Mistakes the interface could invite.** An editor replying in the draft view to a thread for readers writes to readers; the reply box says so, and those threads carry a **Readers** pill there (decision 1). An agent writes for readers only where it can publish, and names the audience of every comment it writes, replies included (decision 10). The comment boxes offer no link or property completion, so an editor can't pick a draft title into a comment for readers (decision 13). Each view keeps its own unsent comment, text and quote, so switching views never carries something typed or chosen for editors into the box for readers (decisions 5 and 13). After an unpublish, readers see only threads started since, as with history, so quotes from a withdrawn version don't come back to them (decision 1); like reader history, that is the server's rule only (A1), since readers hold the keys. The stream and **New comments** tell a reader nothing of comments for editors (decision 8). A quote holds only the page's own text, never values the viewer's screen drew from drafts or other pages (decision 5).
- **A removed member** keeps the comments they read and the key versions they held (A3). A comment written after the rotation is under a key version they don't hold. A server that hides the rotation from a writer, and accepts the write under the old version, is A2, as for a save, and one that serves a key version a removed owner sealed is A5. Both now reach readers' apps too, which write under the share's keys for the first time.
- **Agents read text readers wrote.** A reader's comment is the first text a reader can put in front of an agent, and an agent that edits drafts can answer readers. An agent asked to "answer the comments" could quote the draft to every reader, steered by the reader's words or not. So an agent writes for readers only where it can publish, as the server checks, names the audience of every comment it writes (decision 10), and the agents guide and the MCP tools' descriptions say that comment text is untrusted, and that `--for readers` reaches every reader.
- **A compromised agent host** reads and writes comments as the agent can (A6).
- **First sight** (A4). Readers now verify the signatures of other readers, so their apps pin more people at first sight than before. A server can't post a comment by substituting a commenter's key alone, since it holds no folder key. With a member who holds the share's published key, though, it can: it serves its own key for a reader a viewer has never pinned, signs a comment with it, and the member wraps it, so the viewer sees it as that reader's. Even without a member, the label of a person met for the first time takes its name and email from the directory (section 8.2), so a server can show a real reader's comment under another name the viewer has no label for. That is A4's first sight, wider now that readers meet other readers, where before they met only editors and owners. Where A4 gives the server a member's place outright, by substituting a new member's key when an owner first shares with them, it reads and posts comments as that member, as it reads and writes their pages.
- **Public links** (A12) never hold comments. **Kept for offline** (A13) holds none either (decision 9).
- **Mail** carries nothing about comments (decision 8).

## Considered options

- **One audience for every comment, under the published key.** Simpler, one kind of comment, but an editor's note about the draft ("Shall we drop the part about Gran's recipe?") would reach every reader. The two key classes already draw the line readers and editors expect.
- **A key of its own per page, for comments.** It would let comments ignore the page's audience, but it is a new key class, sealed to every reader of the page by an owner's app and again at every change of members, which is what folder keys already do.
- **Sealing each comment to the people in its thread.** New members and rotations would never reach it, and every reply would need everyone's keys.
- **A new record format, `comment-record/v1`,** with the page, thread and audience signed in the record. Clearer to read, but it needs its own payload AD and envelope domains too, and the payload already binds these fields to the author's signature (decision 3). Decide 3.
- **Comments inside the page's Markdown**, as Obsidian's `%%comments%%`. Readers can't write the page, every comment would be a new version, and comments would conflict with edits.
- **Comments on a version.** Each publish would leave every comment behind on an old version.
- **Passages by position** (offsets in the text). They break with the first edit above them; a quote with its context survives most edits and says when it doesn't.
- **Keeping edit history.** More stored versions for every rewrap to cover, for something nobody asked for.
- **Mail now.** The server can't say which page, so a mail could only say that something is new, and would need settings to turn it off. Decide 6.
- **Signing resolved and deleted.** They change nothing anyone reads, and the server already decides what each person sees.
- **Comments offline now.** It adds a kind of kept item and a kind of queue entry, with their rules, to a first version that works without them. Decision 9.

## Consequences

- Now, with this ADR: `wikistow/protocol.md` gains section 5.9, **Comments**, and notes in sections 1, 2.1, 2.4 (A2, A4, A7, A12), 2.5, 3.5, 5.4, 5.7, 6.1, 6.2, 6.3, 6.7, 6.8, 6.9, 7.1, 7.3, 7.4, 7.6, 9.5, 10, 16 and 18, and Q13, all marked accepted. `protocol-review.md` logs it after the freeze, and its review in rounds 20 and 21. `wikistow.md`'s line on later work points here, `ui-design.md`'s page views name the **Comments** button, and `CONTEXT.md` gains **Comment**, all marked accepted.
- Once built: `wikistow.md` gains a Comments section; `ui-design.md` a Comments section with the panel, the passage button, **New comments** and the phone layout; ADR 0009 decision 8 names comments among what needs the connection; ADR 0007 decision 6 names comments in what a move into another space ends; the agents guide and the CLI's help name the two commands.
- The server gains comment tables and a migration, the routes of decision 12, the scan's `comment` entries, comments in the coverage checks of the four subtree requests, and the stream.
- `packages/client` gains a comments module (seal, open, the checks of decision 4) and comments in the rewrap of making a share, moves, ending a share and adding a co-owner. `packages/ui` gains the panel, the passage button, the rail item and **New comments**.
- Older apps are told to update for the four subtree operations where a page has comments (decision 11).
- Readers' apps write under folder keys for the first time, and so choose key versions and keep **No going back** marks as writers do.

## Implementation, in pull requests

1. **This ADR, the spec and the protocol.**
2. **The server** (built): tables and a migration, the routes, the scan's `comment` entries in every scope, the coverage checks, the trash, deletes, copies and moves into another space, the stream and seen marks, with integration tests: a reader can't fetch a comment for editors, nor post one; a reply in the wrong audience or thread is refused; a share, a move across regions, an ending and a co-owner are refused without the comments' key material; a page in the trash hides its comments; and the content-leak sweep finds no comment text.
3. **The client and the panel, on the page.** The comments module and the checks of decision 4, comments in the four rewraps, the **Comments** button and panel with threads, replies, editing, deleting and resolving, the rail's **New comments**, and the spec. E2e with two browser contexts: a reader asks, an editor answers from the draft view, the reader sees the answer, and never sees a comment for editors; then the folder moves out of its share and the owner still reads every comment.
4. **Passages.** The quote, the **Comment** button over a selection in the published view and the visual editor, underlines in the published view, **Show** in the draft view, and "This passage isn't in the page now". E2e: a comment on a passage, then the passage edited away.
5. **The CLI and MCP.** `page comments`, `page comment`, their tools, help and the agents guide.

Step 3 needs step 2; steps 4 and 5 need step 3.

## Decided (2026-11-09)

Scott accepted every recommendation below on 2026-11-09.

1. **Can readers comment?** Recommended: yes, everyone who can read the page. Questions from readers are the main reason for comments.
2. **Comments for editors only, from the draft view?** Recommended: yes, sealed with the draft key, so readers never see them, with the audience following the view and a reply taking its thread's. The other way, one audience for all, would show editors' notes on drafts to readers.
3. **The record: a metadata record v2 with `subjectKind: "comment"`, or a new `comment-record/v1`?** Recommended: the metadata record, with the page, thread and audience in the payload (decision 3). No new domain strings, and the same path a group's name took.
4. **A comment on the page, pointing at a passage by quote?** Recommended: yes (decision 5), with passages as their own step (4), so page comments can ship first.
5. **Who resolves, edits and deletes?** Recommended: the thread's starter and the page's editors resolve; only the author edits, with no edit history; the author and the space's owners delete (decision 6).
6. **Notifications: none, in the app, or mail?** Recommended: in the app only, with the count and dot on the page's **Comments** button and the rail's **New comments** (decision 8). Mail later, if wanted, as a daily summary each person turns on, holding only a count and a link.
7. **Offline?** Recommended: comments need the connection at first (decision 9).
8. **A move into another space: delete the comments?** Recommended: yes, and say so in its line about what it ends (decision 7). Copies and publications leave them behind; carrying them would make the mover sign everyone's comments.
9. **Agents and the CLI?** Recommended: they list and add comments, as themselves, for readers only where they can publish (decision 10); the chat assistant and plugins don't yet. Export leaves comments out.
