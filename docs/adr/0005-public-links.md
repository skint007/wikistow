---
status: accepted
---

# Public links: a readable copy of one page, served by the server

People want to show a page to someone without an account, the way Joplin publishes a note to a link (#154). Pages are end-to-end encrypted, and the spec says the server stores no plaintext. A public link can't keep that promise: someone with no account and no keys has to be able to read the page. So this ADR makes one exception to the plaintext rule, and settles what the server keeps, how the page is rendered and served, and when the copy goes away.

In short: **Share public link…** uploads a readable copy of the page's published version, its Markdown and the attachments it shows or links to. The server renders it with the reader's own sanitizing rules and serves it at `/p/<id>`, a long random id, with no sign-in, no app script and a strict policy. Each publish from the app replaces the copy, keeping the link. Turning the link off deletes the copy at once, and so does unpublishing the page, deleting it, deleting its space, or the person who shared it losing the right to publish it, by a move or otherwise. Turning it on again makes a new id, so the old link stays dead.

## What the code supports today

- **The server never holds a page in the clear.** Revisions are client-sealed JSON (`revisions.sealed`), and publishing decrypts the draft and re-encrypts it in the client (`publishPage` in `packages/client/src/operations/pages.ts`). The plaintext the server stores is account data, avatars (`schema/avatars.ts`), library plugins and plugin drafts, never page content.
- **The reader lives in the app.** A page body is read in a web worker (`markdown-jobs.ts`: `readBody`, then `highlightCode`) and turned into HTML on the page's thread by react-markdown. Its `urlTransform` drops unsafe link and image addresses, and `pageHtml` (rehype-raw, then rehype-sanitize with GitHub's list) runs when the page has raw HTML. The server has no Markdown pipeline. `@wikistow/client/markdown` has the parser and the wikilink syntax, not the reader's plugins.
- **Wikilinks resolve in the client.** Titles are encrypted, so each version carries an encrypted link table (`wikistow.links`, `linkKey` → page ID), and readers resolve the rest by title against their own tree.
- **Attachments keep their ID across publishes.** `attachment:<id>` names an `AttachmentRef` inside the payload. Publishing re-encrypts each one for the published audience, unless the previous published version's encrypted attachment can be reused (`resealAll`). Either way the server sees only blob hashes and can't map one to an attachment.
- **Paths with no extension, outside `/api` and `/assets`, return `index.html`.** `/p/<id>` reaches the SPA today. Every response gets the app's security headers; a route can send its own CSP, as avatars do.
- **Deleting a page or folder deletes its node row**, and everything with a foreign key to `nodes` goes with it in the same transaction (`deleteNode`). Deleting a space (`deleteSpace`, #158) deletes its row, and its nodes go by cascade in the same transaction.
- **Publish rights change without the page changing.** Moves never check them: an owner can move a page across a share, where its other publishers can't publish it. Removing a member, changing their role or publish rights, group changes and owner changes do it too, through the share's members (`recomputeMembers`) and the owners.
- **Backups are `pg_dump` plus the blob files** (`scripts/backup.sh`).

## Decisions

### 1. The exception to the plaintext rule

The server stores no plaintext page content except the published version of a page someone has given a public link, and only while the link is on. That copy is:

- the published version's title and Markdown body. Its frontmatter is left out, so properties stay encrypted;
- the attachments the body shows or links to, by `attachment:<id>` or `![[file]]`, and no others;
- the server's own rendering of that body.

It is always the page's current published version. A copy is made only of the published head, and any change to the published head deletes the copies of the page in the same transaction (decision 5). So the server never holds an older published version. The server can't check that the Markdown it is sent matches the sealed revision; the app sends the published version it has just opened, never a draft, and a person with publish rights could publish any text anyway. A copy exists only for a page with a link, or while the app uploads one. An upload the app never finishes is deleted within 20 minutes (decision 5).

Copies are deleted in the same transaction as the change that ends them, so once the request returns the database has no row of the copy. The files are rows too (decision 4). `backup.sh` leaves the rows of the three tables out of its dump, so backups don't hold copies, and a restore comes back with every link off.

Turning a link off can't take back what someone already saved, or copies in other backups of the server's disk or database made while it was on. Deleted rows also stay on the database's disk, in its write-ahead log and in any replica until Postgres reuses the space. This is the same limit the spec already states for revoking access and for unpublishing.

### 2. Who can share

A person who can publish the page: the space's owners, and editors with publish rights in its share. The routes are for people only, with a session. An agent can't turn a link on, replace its copy or turn it off. A link is a public disclosure, and the person should make it themselves. An agent can still publish and unpublish the page; what that does to the copy is in decision 5.

A link stays on only while the person who turned it on can publish the page (decision 8). Readers see the marker (decision 9). In the app, only people who can publish the page get the link itself; another public page may link to it too (decision 6).

The app never uploads a copy without saying so on screen. The server tells the app which pages have links, and a dishonest server could claim a private page has one. So a copy goes up only from the public link dialog (decision 9), after its warning, or from the Publish confirmation. Publishing in place is one click on a page without a link. On a page with one, **Publish** first asks: it says the page has a public link and that publishing updates the public page too. Nothing uploads a copy in the background.

### 3. The link

The id is 16 random bytes in base64url (22 characters), from the server's CSPRNG, made each time a link is turned on. Turning a link off and on again gives a new id, so the old one stays dead. A copy replaced at publish keeps its link's id. The id is stored as it is, not hashed, so the dialog can show it again for Copy link; the copy itself sits beside it anyway.

### 4. Storage

Three tables, with no files on disk:

- `public_links`: one row per page with a link: the page (foreign key to `nodes`, cascading), its id, its live copy if any, who turned it on, and when.
- `public_copies`: a copy, staged or live: the page (cascading), the published revision it was made from, its title, Markdown and rendering, its wikilink targets, who uploaded it, and when.
- `public_files`: a copy's attachments (cascading from the copy): attachment ID, name, media type, size and the bytes.

Keeping the files in Postgres, as avatars are, lets every ending be one transaction with no file to unlink after it and no orphan for a sweep to find. Deleting a node, a space's nodes included, deletes the link, its copies and their files by cascade. A file is at most 25 MiB, or the upload limit if that is lower, and a copy's files at most 100 MiB together; an attachment past that is left out of the copy, and the page shows it as not available. Files count toward the uploader's storage quota.

### 5. Sharing and replacing a copy

The app makes a copy in three steps, so the link never shows a copy that is missing files:

1. `POST /api/pages/:pageId/public-copies` with the published revision's ID, title, Markdown, attachment list, resolved wikilinks, and whether it is for a new link. The server checks publish rights and the published head without locks, renders the body with no transaction open and no lock held (decision 6), then takes the locks and checks again: publish rights, that the revision is the page's published head, and for a replacement that the link is on. It stores the copy as staged and answers which files it needs: the attachments the body shows or links to.
2. `PUT /api/public-copies/:copyId/files/:attachmentId` for each file it needs, at most the size declared. Only the person who staged the copy can add to it, only while it is staged, and only while they can still publish the page.
3. `POST /api/pages/:pageId/public-link` with the copy. A copy for a new link turns the link on, with a new id, replacing any link the page had. Otherwise the copy replaces the live one, if the link is still on. Every check of step 1 runs again, and every file it named must have arrived, apart from those left out for size. Then the copy goes live and the page's other copies are deleted.

`DELETE /api/pages/:pageId/public-link` turns it off, deleting the link and every copy of the page, staged ones too.

Staging, committing and turning off take the same locks as publishing, in the same order: the space, the share, the page, then its heads row. Committing also locks the account rows of the link's sharer and the copy's uploader, in order of ID, which suspension locks too, and checks neither is suspended. So a staged copy can't slip past a publish, an unpublish, a move, a change of rights in the share or a turn-off running at the same time, and every change that deletes a page's copies sees all of them.

**A new published version.** Any change to the page's published head deletes every copy of the page, live and staged, in the same transaction: publishing, by a person or an agent, publishing into the page from another space, and unpublishing. The link itself stays on, except on unpublish (decision 8). After the app publishes a page with a link, through the Publish confirmation (decision 2), it makes the new copy at once. Until it arrives, the public page says the page is being updated. If the app can't make it, because the publish came from an agent, from another space or from an app that closed, the public link dialog says the public page is out of date and offers to update it.

A sweep every 10 minutes deletes staged copies that have received nothing for 10 minutes, so one the app never commits, because it closed or lost its connection, is gone within 20 minutes. Until then it is of the current published version and never served, and any change that ends copies deletes it too. Staging is rate limited per person, 20 a minute.

The page updates with each publish from the app, so every publish sends all the attachments again. That keeps the rule simple: one copy, one version.

### 6. Rendering

The server renders the body with the reader's own rules, which move from `packages/ui` to `@wikistow/client/reader` so the app and the server share them: GitHub-flavoured Markdown, alerts, wikilinks, heading ids, highlighted code and `pageHtml`'s sanitizing. The client sends Markdown, never HTML.

- It renders once, when the copy is staged, and records the reader's version with the rendering. When a release changes the reader, as when it fixes the sanitizing, the server renders every copy rendered by another version of the reader again from its Markdown, in the background after it starts. Until a copy's new rendering is stored, its page says it's being updated.
- Rendering runs in one worker thread for the whole server, one page at a time, so a slow page can't stall the server. Each person has one render at a time, and at most 8 wait in all; past that, staging is refused as rate limited. As in the app, a body that takes over 10 seconds, or that's nested past the parser's stack, is shown as written, in a `<pre>` with a note.
- The server always sanitizes, pages without raw HTML too, so every link and image address goes through the sanitizer's list of protocols, as react-markdown's `urlTransform` does in the app. Links that leave the page get `rel="noopener noreferrer"`. Images load only from the copy's own files, and an image elsewhere shows "Image not loaded", as in the app. Only raster images (decision 7) show inline; an SVG or other image becomes a download link. `attachment:` links become download links to the copy's files.
- Code blocks show their language label. There is no copy button, as the page has no script. Alerts get their label as text.

A wikilink to a heading of the page itself (`[[#Dates]]`) links to that heading. Other wikilinks link only to another page whose link is on. The client resolves each wikilink of the published version as a reader would and sends the targets with the copy (`linkKey` → page ID). The server keeps only targets the uploader can publish, who could share those pages' links anyway. The stored rendering is a list of HTML segments with a gap between each. To find the gaps, the renderer marks each wikilink with a random value chosen for that render, after reading the page, and splits the sanitized HTML at those marks. The page can't know the value, so nothing written in it can make a gap. When the page is served, a gap becomes a link to the target's `/p/<id>` if the target's link is on and the uploader can still publish the target, and otherwise the link's text. So a link to a page made public later works without a new copy, and one whose target's link was turned off goes back to text.

The text is the link as written in the published Markdown, its own text or else its target as typed. The server has no titles, so a link without its own text doesn't show the target's current title as it does in the app. Readers already see the written text when they export the page.

Filling gaps when the page is served also means a page's new link shows on every public page that links to it: turning a link off and on again gives a new id, but readers of those pages reach the new one. The public link dialog says so when other public pages link to the page (decision 9). An embedded attachment (`![[file.png]]`) shows from the copy's files.

### 7. Serving

- `GET /p/:id` answers a full HTML page: the title, the body and a short footer. It needs no session and has a rate limit per client, as `publicFile` does. It is registered before the SPA's fallback. Before answering, it checks that the person who turned the link on and the person who uploaded its copy can both still publish the page (decision 8).
- The policy is `default-src 'none'; img-src 'self'; style-src 'sha256-…'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The one inline stylesheet is named by its hash. The page has no script at all, so nothing in it can run even if the sanitizing missed something.
- `X-Robots-Tag: noindex, nofollow` and the same `<meta name="robots">`, so search engines leave it out. The app's `Referrer-Policy: no-referrer` stays, so the id doesn't leak to the sites the page links to.
- `GET /p/:id/files/:attachmentId` serves a file of the link's live copy, with the same check. Raster images (PNG, JPEG, GIF, WebP, AVIF) are served inline with their type. Everything else, SVG and HTML included, is `application/octet-stream` with `Content-Disposition: attachment`, so a file can't run as a page on the app's origin. Files have `default-src 'none'; sandbox` and `nosniff`.
- Pages and files are sent with `Cache-Control: no-store`, so a link turned off isn't served from a cache or proxy. Files get `X-Robots-Tag: noindex` too, for a file's address posted somewhere else.
- An unknown id, a link turned off and a missing file all get the same plain 404 page.

### 8. Turning links off by themselves

- **Unpublishing** turns the link off, in the unpublish transaction.
- **Deleting** the page, or a folder or space holding it, deletes the link by cascade.
- **Losing publish rights.** A link stays on only while the person who turned it on can publish the page. A suspended account can't. A change that takes that away turns the link off in its own transaction: moving the page, or a folder above it, where they can't publish; removing them from the share, directly or through a group; taking away their publish rights; removing them as an owner; or suspending their account. Reactivating them doesn't turn it back on. The same change deletes the copies that person uploaded or staged, and the live ones on links someone else turned on go too; those links stay on and say the page is being updated, until someone updates them. Each of these takes a lock that a commit takes too (decision 5): the space's, the share's, the page's, or the account row of the sharer or uploader. So it sees every link and copy, new ones included. Serving checks the sharer and the uploader every time, and turns off a link or drops a copy it finds lapsed, and the 10-minute sweep checks every link and copy, in case a path this list misses leaves one behind. Without this rule, someone removed from a share could keep reading new versions through a link they made.
- **What removal doesn't do.** Removing someone from a share doesn't turn off links other people made. Anyone who could publish the page could see its link in the public link dialog, and keeps it as they keep anything they saved. Turning the link off and on again gives a new one, which they don't have, unless another public page links to the page (decision 6).

### 9. The app

**Share public link…** joins the sidebar's right-click and ⋯ menus for people who can publish a published page. It opens the public link dialog, apart from the Share dialog that shares a folder with people. Before the first link, the dialog says plainly that anyone with the link can read the page and that the server keeps a readable copy until the link is turned off. With a link on, it shows the link with **Copy link** and **Turn off the link**, says when the public page is out of date, and says when other public pages link to this one, so a new link would show on them too. The tree marks a page with a link for everyone who sees it (`PageSummary.publicLink`), and the page shows the same marker. `PageInfo` gives the link's id only to people who can publish the page.

### 10. Proof

`content-leak.integration.test.ts` stays as it is. Its pages have no link, so nothing of them may be readable anywhere. A new integration test gives one page a link and checks a snapshot of the database, files, logs and mail: only that page's published title, body and the attachments the body shows or links to are readable, never its draft, an older version, another attachment, or another page. Then turning the link off, unpublishing, deleting the page or its space, moving the page where its sharer can't publish, removing the sharer from the share, suspending them, removing a different person who uploaded the live copy, and publishing a new version each leave nothing readable of the old copy at once, and a link turned off answers 404.

## Considered options

- **A key in the link's fragment** (`/p/<id>#<key>`), with the app decrypting in the visitor's browser. The server would keep only ciphertext. But the public page would have to run the app's script, the key would live in browser history and anywhere the link is pasted, and the server could serve changed script to steal it. The issue asks for a page with no app script, rendered by the server.
- **The client uploading HTML.** It would put the sanitizing in the hands of whoever uploads. The server renders instead, with the same rules.
- **Uploading every publish of a page with a link, without asking.** It needs nothing on screen, but the server alone would decide which pages the app sends in plaintext.
- **Rendering on each visit.** No rendering stored, but every anonymous visit would parse Markdown, the step that can take seconds (#47). Rendering once at upload costs a person with publish rights, and a visit only fills the wikilink gaps.
- **Files beside the blobs on disk.** Every ending would need to delete files after its transaction, in many places and in space deletion, with a sweep for what a crash leaves. Rows cascade.
- **Keeping the older copy until the new one arrives.** No gap after a publish, but an agent's publish would leave the older version public with no end, against decision 1.
- **One request for the copy and its files.** No staged copies, but files can be large, and a JSON body or a multipart parser for this alone is more than three small routes.
- **Giving the server the version's keys,** so it decrypts the copy itself. Those keys also open the stored ciphertext, in the database and in every old backup, for good.
- **Agents managing links.** Left out on purpose (decision 2).

## Consequences

- The spec's plaintext rule, "what the service can see", the static SPA note, the CSP section, the record table, the storage paragraph and the release evidence change with this ADR, and so do the protocol's guarantees and accepted risks.
- The server gains three tables and a migration, four routes, the two `/p/` routes, and the reader's Markdown dependencies (remark, rehype, lowlight) through `@wikistow/client/reader`.
- The tree response gains `publicLink` on each page. `PageInfo` gains the link for publishers.
- A server restored from a backup has every public link off.

## Decided (2026-10-21)

Scott decided on 2026-10-21 to change the spec rather than drop the feature: the server stores no plaintext except the published version of a page with a public link, only until the link is turned off or the page is unpublished, deleted, moved where the person can't publish it, or its space is deleted. Never drafts or older versions. The limit is stated plainly, as for revoking access. The leak test stays as it is, and a new test covers the exception.

## Implementation, in pull requests

1. **This ADR and the spec.**
2. **The shared reader.** The reader's plugins and `pageHtml` move to `@wikistow/client/reader`, unchanged, and the app imports them from there. The app reads pages exactly as before.
3. **The server.** The tables, the routes, rendering in a worker thread, the `/p/` pages, turning links off on unpublish and on lost publish rights, deleting copies on publish, the cascade on delete, `backup.sh` and `docs/operations.md`, and the new leak test. Space deletion (#158) deletes nodes by cascade, so it needs no hook of its own; the new test covers it.
4. **The app.** The menu item, the public link dialog, the Publish confirmation and its upload, the markers, and `ui-design.md`. Closes #154.
