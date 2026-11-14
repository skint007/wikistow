# Changelog

What changed in each WikiStow release, newest first. The app's **What's new** page shows each release's highlights, and each GitHub Release's notes are made from its entry here. [Releasing](docs/releasing.md#the-changelog) says how to write an entry and when.

## Unreleased

### Highlights

#### Features

- Plugins can say which devices they work on: the desktop app, a computer’s browser and a phone. The library and the install dialog show it as tags, Works on this phone lists only the plugins that work there, and installing one where it says it doesn’t work warns first.
- Plugins can list pages by their properties, and draw an imported vault’s dataview blocks. Settings → Plugins shows which plugin draws each kind of code block.
- Put pages and folders in an order of your own: drag one between two rows, or use Move up and Move down in its menu. Everyone who sees the folder sees the same order, and Sort by name puts it back.
- Give plugins’ commands keyboard shortcuts in Settings → Plugins. Plugins can now split and merge notes: they can move pages to the trash once you agree, asked once for them all, save many pages at a time, and point links at a heading that moved to its new page.

#### Optimizations

- Importing notes sends about a third as many requests, so an import over a slow connection takes about 40% of the time it did.

### Changes

#### App

- A plugin's manifest can name the devices it works on, `platforms`: the desktop app, a browser on a computer and a phone (wherever the app shows its phone layout), each `full`, `partial` or `none`, with a short note. The library and the approval dialog show it as tags, such as **Desktop app only** or **Phone partial**, or **Devices not stated**. **Works on this phone** (or this browser, or this desktop app) in the library lists only the plugins that say they work there. Installing one on a device it says it doesn't work on warns, then installs. A plugin that registers a view in `app.titlebar`, which only the desktop app has, warns at upload, on each workshop build and in `wikistow-plugin build` when it says it works fully in a browser or on a phone, or not in the desktop app. The workshop's assistant sets the field. The library lists versions with `platforms` only to apps that send `manifest=4`. (#407)
- **Import…** and `wikistow import` send about a third as many requests: 2 for a page whose note names no other note or file, 3 for one that links, and 2 for an attachment, down from about 8 and 3. Where to write is asked once a folder, a page is published from the draft just saved, and each attachment's copy for readers is sealed from the file read rather than downloaded again, two attachments at a time. Each change goes with an idempotency key and is sent again when its answer is lost, so nothing is made twice. 100 notes at a 300 ms round trip took 107 s instead of 280 s. (#410)
- Plugins can list pages by their properties. `host.pages.index(spaceId)` gives each page of a space they can read with its title, folder, tags and properties, and `host.pages.query({ spaceId, from, where, sort, limit })` lists what a `wikistow-query` block of those lines would. Both read your search index, never the pages again, and cover only the pages you gave the plugin. `index.changed` tells a plugin when that index changes, or its page access does. Scripts get them too. An app plugin can claim a bare fence language in its manifest's `fences`, such as `dataview`, so an imported vault's blocks are drawn by it: the approval dialog says so, and **Code blocks plugins draw** in Settings → Plugins shows which plugin draws each, with **Show as code** and **Use _plugin_**. Without the plugin they stay code. The library lists versions with `fences` only to apps that send `manifest=4`. A new example, `vault-tables`, draws a part of Dataview's `TABLE` and `LIST` queries. (#411)
- Each folder, and the top of a space, has one order, shared by everyone who sees it. A drop on the line between two rows puts a page or folder there: in its own folder it reorders, and in another it moves and lands there, with Ctrl to copy, Undo, and Ask before moving as before. A drop on a folder's row still moves it in, last. **Move up** and **Move down** are in each row's menu, and page rows have a ⋯ menu, so phones reach them. **Sort by name**, in a folder's menu or the space's for its top, lists it by name again. Folders and pages mix; something new, moved or copied in goes last, and a restore goes back to its place. The folder view, plugins' `pages.list` and `pages.tree`, `wikistow tree` and agents' `list_pages` list in the same order. Offline, a reorder waits on the device as one change to its folder. (#413)
- The visual editor writes again only the blocks you edit. The rest of the page keeps its own Markdown, byte for byte, where an edit used to rewrite every block in the editor's style. Text typed in the source in **Split**, and changes the app makes such as a renamed link, go into the visual editor a block at a time, and a long page's first edit no longer waits for the whole page to be read back (ADR 0015, step 2). (#417)
- Plugins split, merge and bulk-edit pages, as Obsidian's Note Refactor does. Settings → Plugins lists each running plugin's commands under **Shortcuts**, where **Set** takes the keys pressed next, kept on this device; keys the app, its editors, the desktop app's window or a browser already use are refused, saying whose they are, and so are another command's. The command palette shows them. `host.pages.trash(pages)` moves pages within the plugin's write access to the trash, in spaces you own, once you agree in one prompt listing every page, with Undo after. `host.pages.saveDrafts(changes)` saves up to 500 drafts as one of the plugin's 30 writes a minute, about one a second, each with its own result. `host.pages.relink(moves)` points the links to a page, or to one of its headings, at another page, in the pages linking there. A script's command or event isn't timed while one of these waits. A new example, `note-refactor`, splits the selection into a page and merges the pages it links to. (#428)

- The No going back marks (protocol section 6.8) as ADR 0015 needs them across a browser's tabs. An owner's app that rotates a share's keys, removes an owner or makes a group change that rotates raises its own mark to the version it made. Before it sends a rotation, an owner's removal, an ending or a move into or out of a share, it records the change as pending in its kept marks, waits for that to land, and tells its other tabs on a `BroadcastChannel` that carries nothing else; until the answer comes, no tab joins or sends in that share's live sessions. A change whose answer was lost stays pending until the app fetches the share again and sees which way it went. Tabs read the marks again before they write under, rotate from or move content into a share, and when another tab says it wrote them, and a cleared change never comes back. (#425)
- Plugins' page rows, from `host.pages.index()` and `host.pages.query()`, say when the version they show was saved, as `updated`: the server's time for it, which its author didn't sign, or this device's clock for a version saved here. The search index, the versions kept on the device and the kept index hold it too. A version kept before times were is asked for again once online, and kept with its time. (#426)
- Search and the command palette open when opened again right after Escape closed them. On a busy computer, a key or click just then could open nothing: Escape closed the dialog at once, but the app heard of it a moment later, after the key or click. (#433)

- A line given to the visual editor under a table, where the blank line after it went, shows as the table's last row, as reading the page does, from Split or a change the app makes. It showed as a second table, with an empty header and row, which the next edit wrote out in the editor's style. (#436)

- Query tables and plugins' queries can name `saved`, when the version listed was saved: `sort: saved desc` lists the pages saved last first, `show: saved` shows the time, in your time zone, and `where: saved > 2026-01-01` the pages saved since. A time not known yet sorts last and leaves its cell empty. `saved` means the time, not a property of that name; a property named `updated` is like any other. It sorts by what plugins' rows give as `updated`. A plugin's query also takes Dataview's `file.mtime` for it, and the `vault-tables` example reads `SORT file.mtime DESC`, `WHERE file.mtime > date(…)` and a `file.mtime` column. A public link's copy writes each listed publication's time, in UTC. Dates in queries now compare to the millisecond. (#427)

#### Desktop

- The desktop app answers the web clipper's helper (ADR 0017, step 2, #406). The browser starts `wikistow-clip-host`, a small Go program installed beside the app, for the WikiStow extension through native messaging. It relays to the running app over a Unix socket in a folder only the person can open, or a named pipe on Windows, once both prove they hold the token in `clip-host.json`, a file only the person can read, and starts a closed app outside the browser's reach. At each launch the app writes the browsers' host manifests, per user, for the browsers it finds, naming only the published extensions. None is published yet, so a release writes none until each store holds the extension's ID; `--clip-extension` adds one for a launch, for testing. **Settings → Browser clipping**, on by default, turns it off, which closes the socket and deletes the manifests, and on Windows their `HKCU` keys. The app only answers so far: it saves no clip yet. (#432)

- Search by meaning indexes pages in the background, step 4 of ADR 0016 (#324). It's on by default in the desktop app with a keyring, and a computer's browser can turn it on in Settings → Pages. Both need **Keep for offline** on Every page, and phones don't get it yet. Once the search index is built, the app embeds each page it holds, most recently changed first, one passage at a time. It rests half as long as each passage took, and waits while a page opens or the index updates. A draft you're typing is embedded once its saves have paused for 30 s; until then the version before stands in. A new version embeds only the passages whose text changed. The vectors are kept sealed beside the search index, bound to the model and not the app's build. They open at unlock and leave memory at lock. They're deleted at sign-out, and when the setting goes off, which also deletes the browser's copy of the model. Settings says how far it has got ("By meaning: 340 of 1,200 pages so far"). Search uses them in step 5. (#450)
- The desktop app keeps search by meaning's vectors in a `meaning-index` file beside `search-index`, only with a trusted keyring, deleted at sign-out and at a new sign-in, through the bridge's `meaningIndex`, `keepMeaningIndex` and `dropMeaningIndex`. (#450)
- The desktop app saves the web clipper's clips as drafts (ADR 0017, step 4, #406). Each becomes a new page made with the page writer, so one made offline waits in the queue with its images: its HTML as Markdown pasting it would write, a link as its note, selection and link in plain text, with the properties `source`, `clipped`, `tags` and an article's `author`, and never others from frontmatter-like text in the clip. Main fetches the images itself and the page attaches them: no cookies or credentials, the page's origin as `Referer`, five redirects at most, each name checked as it's looked up and connected to as checked, nothing from this computer or the local network unless the clipped page is on one (by its address, or a local name such as `nas` or `wiki.lan` whose addresses are all local), raster types only by their bytes (not SVG), 24 MiB each, 50 and 100 MiB and two minutes a clip, one at a time. The extension hears the vault's real state: starting, signed out, locked or ready, and offline. A clip that comes while the app starts or is locked waits in memory until it's saved, the unlock page says so, and closing asks first; one whose folder can't take it any more asks where it goes. A notice says where each clip went, with **Open**, and Settings → Browser clipping lists this session's last ten while unlocked. The extension can search folders (50 matches and the five used last, only while unlocked) and open a draft clipped this session. One clip at a time, 30 a minute; 60 searches and 200 images a minute. (#447)

#### Server

- A page's or folder's `position` among what is in its folder, a fractional index (migration `0049_node_positions`). `GET /api/spaces/:spaceId/tree?order=1` lists positions, which released apps never ask for. `POST /api/spaces/:spaceId/order` sets them and `POST /api/spaces/:spaceId/order/by-name` clears them, for editors there and their agents. A move may carry a `position`; without one, as from released apps, it goes last in a folder with an order of its own. (#413)
- Dependencies with security advisories: `hono` 4.13.16, from 4.13.12, and `@hono/node-server` 2.1.6, from 2.1.3, in the server, the CLI and the web app's dev server. (#418)

#### CLI

- `wikistow tree` lists each folder's pages and folders in its order, and its JSON gives each an `order`. (#413)

#### Releases and packaging

- The web build carries the model search by meaning will run, step 2 of ADR 0016 (#324): `bge-small-en-v1.5` at 8 bits, fetched from Hugging Face at a pinned revision and checked against its SHA-256, with its tokenizer and ONNX Runtime Web's WebAssembly, each with a Brotli copy. The server sends `/assets/*` as their Brotli copies to browsers that accept them. The service worker keeps none of them, so nobody downloads them who doesn't use them, and the desktop app ships them without the copies, about 50 MB more. `/third-party-notices.txt` gives the model's, the runtime's and the tokenizer's licences, and `/third-party-notices-onnxruntime.txt` the runtime's own notices. A build fails if the service worker would keep a file over 4 MB. Nothing embeds yet. (#430)
- `@electron/asar` 4.3.2, from 4.3.1, which builds the desktop app's `app.asar`. It brings `glob` 14 and `minimatch` 11, past their security advisories. (#418)
- Every desktop package carries the web clipper's helper: the release archive and the AUR packages, the `.deb` and `.rpm`, the Windows installers and the Mac apps, where it's signed with the app. The Windows installer waits for it to close, as for the app, and its uninstaller deletes the host manifests and their keys; uninstalling the Homebrew cask deletes the Mac manifests. CI builds the helper with Go for every system in its build job, tests it against a fake app on Linux, Windows and macOS, and checks that each package's copy answers. (#432)

#### Development

- A visual-editor browser test runs alone, as `-t` asks: its editor mounts without an earlier test having made the shared hidden editor. The test helpers waited for it inside `act`, which held back React's retry once the syntaxes' editor nodes loaded. They now let React work between tries (`pollActing`). The app has no `act`, so people never had this. (#438)
- The embedding worker for search by meaning, step 2 of ADR 0016: ONNX Runtime Web 1.31.1 on WebAssembly, one thread, with `@huggingface/tokenizers` 0.2.0, both dependencies of `packages/ui`, in a module worker of the app's own, which keeps the model's files in a cache of its own (`wikistow-meaning-`) in a browser, and reads the desktop app's from disk. Browser tests embed a text under the app's policy, from the server, from the cache and offline, and in the packed desktop app. Nothing in the app starts it yet. (#430)
- The client's `live` module, step 5 of ADR 0015 (live editing, #321), in `@wikistow/client/live`: the session record, wrapped with the share's draft key or sealed to the owners; messages padded, sealed under the session key and signed, both bound to the record's hash; the Yjs client ID each join derives; the strict decoding of Yjs updates and states before anything reaches Yjs; each join's `seq` and `clock`; the snapshot check; and `wikistow.live`. Nothing calls it yet. Test vectors pin the three new domains. `yjs` 13.6.33 is a dependency of `packages/client`. (#419)
- The browser tests check that a query table, and a plugin's block listing pages, follow a listed page's change without a reload, made here or in another session. Their helper for typing in the source editor refuses frontmatter on a page that has Properties, where it would go into the body as text, and a new one sets a property instead. (#420)
- The client's `meaning` module, step 3 of ADR 0016 (search by meaning, #324): a page's reduced text cut into passages of at most 256 tokens at its headings, then its paragraphs; vectors kept as signed bytes with one scale; the scan for the pages nearest a query, each by its best passage; and the file the vectors are kept in, sealed under `meaning-index-key/v1` and bound by `meaning-index/v1` to the model's hash and how passages are cut, not to the build. The search index keeps where each heading starts in a page's text, so its kept file from an earlier build is read again, as after any update. Nothing calls the module yet. Test vectors pin the two new domains. (#429)
- The copy sweep's integration test analyzes `nodes` before inserting its 33,000 hidden pages. Without it, each row's parent check could reuse a plan its connection made while the table was nearly empty, which looks the parent up by space alone, and the insert ran past the test's 60 s. (#435)
- HTML made Markdown with no editor open, step 3 of ADR 0017 (the web clipper, #406), for clips to become pages as a paste of them would. `htmlMarkdown` in `packages/ui` pastes the HTML into an empty page in a visual editor nobody sees, with the same cleaning (`unstyled`), schema, paste handling and rules for each change as a paste, and writes it with the visual editor's writer. It runs in the app's page, not its main process, as it reads HTML and styles with a browser's DOM, as a paste does. The visual editor and it share one list of those rules (`changeRules`). Tests check that a clip and a paste of the same HTML give the same Markdown: hidden content, images and their sources, Word's lists, links, footnotes, tables, and HTML that can't be read. (#434)

## 0.25.0 - 2026-11-11

### Highlights

#### Upgrade notes

- Update the desktop app and the CLI on every device. Older versions can’t share a folder, move one into or out of a shared folder, stop sharing or add a co-owner where a page has comments, and they don’t show comments.

#### Features

- Comment on pages. **Comments** in a page’s toolbar opens its threads beside the page. A comment made while reading is for everyone who reads the page; one made in the draft is for editors only.
- Comment on a passage: select text in a page, or in the draft’s visual editor, and press **Comment**. The passage is underlined, and its thread says when it’s edited away.
- **Comments** in the rail lists new comments on your threads, and new threads on pages you can edit.
- When your edit and someone else’s clash, Merge… combines them: changes to different parts combine on their own, and where you both changed the same part you pick yours, theirs, both, or edit it. It works for edits made offline and in another window too.
- Owners can stop sharing a folder or the space, from its Share dialog or Members and owners. It goes back to the owners alone, so the folder above it can be shared. Members keep what they already read.
- Sign in with a passkey, with Use a passkey on the sign-in page, also when signing in the desktop app. It counts as both factors, so there’s no two-factor code. Add and remove passkeys in Settings → Security.
- The search box is a command palette too: type `>` first, or press Ctrl+Shift+P (Cmd+Shift+P on a Mac) or F1, then type what you want to do.
- Moving and copying ask less. Move to… and Copy to… take one step, dragging moves at once and Ctrl+drag copies (Option on a Mac), with Undo for 10 seconds. Ask before moving is now off by default.
- Drag a page or folder from the sidebar onto another space in the rail to move it there.
- While offline you can rename folders and change their look, delete pages and folders, move them within their space, and publish pages. The changes wait on the device and go once you’re back online.
- A page or folder moved to another space keeps its old address, which opens the new place, and its public link, at the same address. Links in folder tables and query blocks open it there too.
- Owners can move or copy everything in a space into another space, with Move space into… and Copy space into… in the space menu.
- Export… can write links between pages as relative Markdown links, for GitHub and editors that don’t read wikilinks.
- The icon picker’s Image tab offers the images already used in the space, and Shared with me shows each folder’s and space’s own look.
- Plugins can keep settings, the same on each of your devices, and Settings → Plugins draws the settings a plugin declares. A library plugin can be turned off in one browser or on one computer only.
- App plugins can draw the search results their own way.
- The plugin workshop keeps its conversation, versions and sample pages, so you can reload or switch devices and carry on. Drafts can hold fonts and images.
- Share a plugin draft with people you name, or send a change to someone else’s plugin back to them with Propose to its owner.
- Load development folder… works in a computer’s browser too.
- Agent tools that speak MCP can use WikiStow through `wikistow mcp`, with the same commands and checks as the CLI.
- Agents read and add comments, with `wikistow page comments` and `wikistow page comment`, also in `wikistow mcp`.
- The CLI can move pages and folders and rename folders, and its page history says what a change made while reading did, such as “Ticked 3”.

#### Fixes

- Mermaid diagrams now draw in the browser after an offline reload. A diagram that can’t shows its source at once, instead of “Drawing diagram…” for two minutes.
- A draft opened right after someone else saved it, as from Agent activity, opens on their draft, instead of an older one with a false conflict.
- A folder renamed offline is renamed once you’re back online, even if someone moved it into or out of a shared folder meanwhile.

#### Maintenance

- The desktop app runs on Electron 44.11.1.

### Changes

#### App

- Comment on pages. **Comments** in a page's toolbar opens its comments beside the page, or over it on smaller screens. A comment made while reading is for everyone who reads the page; one made in the draft is for editors only, and readers never see it. Reply, edit and delete your comments, and resolve threads you started, or any thread on a page you can edit. Owners can delete any comment. Comments are end-to-end encrypted like the page and follow it when it is shared or moved within its space. **Comments** in the rail lists new comments on your threads, and new threads on pages you can edit. Comments need the connection. (#390)
- Comment on a passage: select text in a page, or in the draft's visual editor, and press **Comment** above it. The comment quotes the passage, which is underlined in the page; clicking it opens the thread. When the passage is edited away, its thread says so, with a link to the published version it was on. In the draft, **Show** selects the passage. (#392)
- When someone else saved a draft while you were editing it, **Merge…** combines your changes with theirs. Changes to different parts of the page combine on their own; where you both changed the same part, you see both side by side and pick yours, theirs, both, or edit it. You review what saving changes before the merged draft saves. (#384)
- **Merge…** also works for a page you edited offline that someone changed meanwhile, and for a change you saved in another window or tab on the same device. (#385)
- Owners can stop sharing a folder or the space, from its Share dialog or Members and owners. It goes back to the owners alone, so the folder above it can be shared. Its members keep what they already read or downloaded, and nothing saved afterwards reaches them. (#381)
- Sign in with a passkey, a fingerprint, face, screen lock or security key, with **Use a passkey** on the sign-in page, and in the browser when signing in the desktop app. It counts as both factors, so there's no two-factor code. Add, name and remove passkeys in Settings → Security; the desktop app lists and removes them. Passwords keep working, and your vault passphrase is still asked for. (#366)
- The search box is a command palette too: type `>` first, or open it with Ctrl+Shift+P (Cmd+Shift+P on a Mac) or F1, to run what you could do where you are by typing its name. It lists the page's commands, such as Edit page, Publish, Move to… and Find on page, the space's (Export space…, and for owners Share space… and Delete space…), Lock vault, Change theme…, each plugin's settings, and the running plugins' commands under their plugin's name. Letters match in order, best matches first, then the commands you ran last, kept on this device. (#345)
- Moving and copying ask less. **Move to…** and **Copy to…** take one step: pick the place, then **Move** or **Copy**. Dragging a page or folder in the sidebar moves it at once, within the space or onto a space in the rail, and Ctrl+drag (Option on a Mac) copies it. A notice says where it went, with **Undo** for 10 seconds. Nothing lists who gains or loses access any more: one line says when more people will be able to read it, and one what a move ends. **Ask before moving** is now off by default; turned on, a drop opens **Move to…** on that place. Moving everything in a space still asks first. (#380)
- Drag a page or folder from the sidebar onto another space in the rail to move it there. (#357)
- Rename a folder, change its emoji, colour or icon, and delete pages and folders while offline. They wait on the device and go once the app is back online. (#347)
- Move pages and folders within their space, by Move to… or by dragging, and publish pages, while offline. They wait on the device and go once the app is back online; a waiting publish can be cancelled from the page. Moves into or out of a shared folder, and publishing a page with a public link, still need the connection. (#354)
- A folder renamed offline is renamed once you're back online even if someone moved it into or out of a shared folder meanwhile. Before, its change was refused and could only be discarded. (#377)
- A page or folder moved to another space keeps its old address: opening it opens the new place, saying it moved, and links to it from pages left behind still open it, for people who can open it there. (#351)
- A link in a folder table or a query block to a page moved to another space opens it there, as the linking page's own link does. A query block's links also follow a renamed page now. (#369)
- A page moved to another space keeps its public link, at the same address, where you can publish it there. Its public page says it's being updated until you open Share public link… there and update it. A link the move can't keep ends, as before, and the move says so. (#355)
- Owners can move or copy everything in a space into a folder of another space, from the space menu (**Move space into…**, **Copy space into…**), which asks first. After a move, the space is empty and the app asks whether to delete it. (#356)
- **Export…** has a **Markdown links** switch, off by default, that writes links between pages as relative links to their files, `[Plan](../Work/Plan.md#next-steps)`, for GitHub and editors that don’t read wikilinks. It says how many links stayed wikilinks, such as page embeds. (#350)
- The icon picker's **Image** tab has an **In this space** row of the images already used in the space, its folders and its pages, each once. Picking one copies it, so the same picture can go on several folders or pages without uploading it again. (#360)
- **Shared with me** shows each shared folder with its own emoji, colour, icon or image, as the sidebar does, and each shared space with its tile from the rail. (#362)
- A draft opened right after someone else saved it, as from **Agent activity**, opens on their draft. Before, it could open an older draft and say someone else saved a newer version. (#382)
- Mermaid diagrams now draw in the browser after an offline reload. The diagram frame's files are named by their hashes under `/assets/diagram/`, so the browser's cache keeps them, and the service worker fetches them once when it installs. A diagram that can't draw offline shows its source and says so at once, instead of "Drawing diagram…" for two minutes. (#342)

#### Plugins

- Plugins can keep settings for the person, the same on each of their devices: `host.settings` (`get`, `set`, `update`, `on('changed')`), one JSON object of at most 16 KB per plugin, kept encrypted beside the plugin's approval in the account's record, or on the computer for a desktop folder install. A manifest's `settings` declares text, number, on/off and choice fields, which Settings → Plugins draws under the plugin's **Settings**, so scripts get settings without a view. Settings sections get `{ settings }`, `host.app.navigate({ kind: 'settings' })` opens the plugin's own, and the page's Plugins menu has ***Plugin* settings…**. An update keeps them and Remove deletes them. `reading-room` declares its column's width and reading speed. The library lists versions with `settings` only to apps that send `manifest=3`. (#344)
- A library plugin can be turned off in one browser or on one computer only, and stay on on your other devices: Settings → Plugins has a second switch beside **Your account**, labelled **This browser** or **This computer**. Off there, the plugin doesn't load on that device at all. It's kept on the device, and removing the plugin forgets it. (#349)
- App plugins can draw the search results their own way: `search.results` is a replaceable region, whose view gets what was typed and the app's own results, and draws only where the plugin can read every result. The search box and `>`'s commands stay the app's, and `host.app.navigate` closes search. (#352)
- **Load development folder…** in Settings → Plugins works in a computer's browser too: choose a plugin's built `dist/` folder, approve it, and press **Reload** after each build. Chrome and Edge read the folder again; Firefox and Safari ask for it again at each **Reload…**. The plugin runs in that tab only, labelled Development, until you close or reload the tab or remove it, and replaces a library plugin of the same ID there. Each build goes to the server as your own development build, served only to you and dropped a week after the last Reload (migration `0042_plugin_development`). (#364)
- Plugin drafts hold fonts and images (`.woff2 .woff .ttf .otf .png .jpg .jpeg .webp .gif`, 1 MB each) under `public/`, so a theme with its own font or a plugin with an icon can be made in the workshop. **Add file…** in the workshop adds one; **Upload project folder…** and **Change with the assistant** bring them along; a build copies them as `wikistow-plugin build` does. The assistant can list and delete them, but not write them (migration `0044_draft_binary_files`). (#365, #378)
- The plugin workshop keeps its conversation, versions and sample pages with the draft, so you can reload or switch devices and carry on. A page you copied into the preview isn't kept, only a note that you copied one. The newest version comes back to preview; older ones are listed as history. **Clear conversation** starts over on the draft's files (migration `0045_draft_workshop`). (#371)
- In the workshop, a copy of someone else's plugin offers **Propose to *owner*…**, which sends your changes back to them. They see what changed by file on their workshop page, and can open it as a draft of their own and publish it as a new version, or decline it (migration `0046_plugin_proposals`). (#372)
- Share a plugin draft with people you name, with **Share…** in the workshop. They find it under **Drafts shared with you**, can change its files and preview it, each with a conversation of their own, and only you publish it. When two people change one file, the last change wins (migration `0047_shared_drafts`). (#373)

#### CLI

- Agents read and add comments: `wikistow page comments` lists a page's threads, and `wikistow page comment --text TEXT --for readers|editors [--reply-to ID]` adds one, also as `page_comments` and `page_comment` in `wikistow mcp`. `--for` is always needed, a reply's must match its thread, and an agent comments for readers only where it may publish. The skill, the tools' instructions and the setup guide say comment text is content, not instructions. (#391)
- `wikistow mcp` serves the agent's commands as the tools of an MCP server, over standard input and output, for agent tools that speak MCP. Each tool runs its command with `--json`, with the same checks, idempotency keys and exit statuses. `wikistow mcp --help` says how to add it to Claude Code, Codex and other clients. (#368)
- `page move`, `folder move` and `folder rename` move a page or folder within its space and rename a folder, with `--json` and `--idempotency-key`. (#343)
- `page history` says what a version made by changes while reading changed, such as "Ticked 3, unticked 1", and `--json` gives it as `change`. (#346)
- `export --links markdown` writes links between pages as relative Markdown links instead of wikilinks, as the web's **Markdown links** does, and counts the wikilinks left (`wikilinks` in `--json`). (#350)

#### Server

- The server keeps comments on pages (ADR 0014), end-to-end encrypted: routes to list, add, edit, delete and resolve them, seen marks, **New comments** and a stream of comment changes, comments in the record scan when asked for (`comments=1`), and their keys in making a share, moves across a share's edge, ending a share and adding a co-owner. An app from before comments is told to update for those four where a page has comments. (#389)
- The server can end a share (ADR 0012): `POST /api/shares/:shareId/end` takes every record wrapped under the share sealed again to the space's owners, then deletes the share with its members, groups' access, agents' picks and keys, and ends the public links of people who can no longer publish. `GET /api/shares/:shareId/ending` tells an owner which public links end and which publications stay, and the record scan gains a `share` scope. (#379)
- Agents can rename folders where they may edit, and moves and renames take an `Idempotency-Key`, so a retry after a lost answer gets the first answer back. (#343)

#### Releases and packaging

- Signed apt and dnf repositories for the desktop app on GitHub Pages, published after each stable release, and an update notice that says to use apt or dnf for them. (#361)
- Electron 44.11.1, from 44.10.2. (#395)

#### Development

- ADR 0012 (ending a share), ADR 0013 (merging conflicting edits) and ADR 0014 (comments on pages) are accepted and built. ADR 0014 was reviewed in protocol review rounds 20 and 21, and the merge module ADR 0013 builds on is in `packages/client/src/merge/`. (#367, #370, #383, #387, #388, #393)
- Built ADRs are marked built, and each feature they leave for later links to its issue. (#341)
- CI retries its downloads from GitHub Releases in the AUR, Homebrew and Mac app jobs. (#353)

## 0.25.0-beta.4 - 2026-11-10

### Highlights

#### Upgrade notes

- Update the desktop app and the CLI on every device. Older versions can’t share a folder, move one into or out of a shared folder, stop sharing or add a co-owner where a page has comments, and they don’t show comments.

#### Features

- Comment on pages. **Comments** in a page’s toolbar opens its threads beside the page. A comment made while reading is for everyone who reads the page; one made in the draft is for editors only.
- Comment on a passage: select text in a page, or in the draft’s visual editor, and press **Comment**. The passage is underlined, and its thread says when it’s edited away.
- **Comments** in the rail lists new comments on your threads, and new threads on pages you can edit.
- Agents read and add comments, with `wikistow page comments` and `wikistow page comment`, also in `wikistow mcp`.

### Changes

#### App

- Comment on pages. **Comments** in a page's toolbar opens its comments beside the page, or over it on smaller screens. A comment made while reading is for everyone who reads the page; one made in the draft is for editors only, and readers never see it. Reply, edit and delete your comments, and resolve threads you started, or any thread on a page you can edit. Owners can delete any comment. Comments are end-to-end encrypted like the page and follow it when it is shared or moved within its space. **Comments** in the rail lists new comments on your threads, and new threads on pages you can edit. Comments need the connection. (#390)
- Comment on a passage: select text in a page, or in the draft's visual editor, and press **Comment** above it. The comment quotes the passage, which is underlined in the page; clicking it opens the thread. When the passage is edited away, its thread says so, with a link to the published version it was on. In the draft, **Show** selects the passage. (#392)

#### CLI

- Agents read and add comments: `wikistow page comments` lists a page's threads, and `wikistow page comment --text TEXT --for readers|editors [--reply-to ID]` adds one, also as `page_comments` and `page_comment` in `wikistow mcp`. `--for` is always needed, a reply's must match its thread, and an agent comments for readers only where it may publish. The skill, the tools' instructions and the setup guide say comment text is content, not instructions. (#391)

#### Server

- The server keeps comments on pages (ADR 0014), end-to-end encrypted: routes to list, add, edit, delete and resolve them, seen marks, **New comments** and a stream of comment changes, comments in the record scan when asked for (`comments=1`), and their keys in making a share, moves across a share's edge, ending a share and adding a co-owner. An app from before comments is told to update for those four where a page has comments. (#389)

#### Development

- ADR 0014 (comments on pages) is accepted, reviewed in protocol review rounds 20 and 21, and built. (#387, #388, #393)

## 0.25.0-beta.3 - 2026-11-09

### Highlights

#### Features

- Owners can stop sharing a folder or the space, from its Share dialog or Members and owners. It goes back to the owners alone, so the folder above it can be shared. Members keep what they already read.
- When your edit and someone else’s clash, Merge… combines them: changes to different parts combine on their own, and where you both changed the same part you pick yours, theirs, both, or edit it. It works for edits made offline and in another window too.
- Moving and copying ask less. Move to… and Copy to… take one step, dragging moves at once and Ctrl+drag copies (Option on a Mac), with Undo for 10 seconds. Ask before moving is now off by default.
- Plugin drafts take .ttf and .otf fonts and .jpeg images too.

#### Fixes

- A draft opened right after someone else saved it, as from Agent activity, opens on their draft, instead of an older one with a false conflict.
- A folder renamed offline is renamed once you’re back online, even if someone moved it into or out of a shared folder meanwhile.

### Changes

#### App

- When someone else saved a draft while you were editing it, **Merge…** combines your changes with theirs. Changes to different parts of the page combine on their own; where you both changed the same part, you see both side by side and pick yours, theirs, both, or edit it. You review what saving changes before the merged draft saves. (#384)
- **Merge…** also works for a page you edited offline that someone changed meanwhile, and for a change you saved in another window or tab on the same device. (#385)
- A folder renamed offline is renamed once you're back online even if someone moved it into or out of a shared folder meanwhile. Before, its change was refused and could only be discarded. (#377)
- Owners can stop sharing a folder or the space, from its Share dialog or Members and owners. It goes back to the owners alone, so the folder above it can be shared. Its members keep what they already read or downloaded, and nothing saved afterwards reaches them. (#381)
- Moving and copying ask less. **Move to…** and **Copy to…** take one step: pick the place, then **Move** or **Copy**. Dragging a page or folder in the sidebar moves it at once, within the space or onto a space in the rail, and Ctrl+drag (Option on a Mac) copies it. A notice says where it went, with **Undo** for 10 seconds. Nothing lists who gains or loses access any more: one line says when more people will be able to read it, and one what a move ends. **Ask before moving** is now off by default; turned on, a drop opens **Move to…** on that place. Moving everything in a space still asks first. (#380)
- A draft opened right after someone else saved it, as from **Agent activity**, opens on their draft. Before, it could open an older draft and say someone else saved a newer version. (#382)

#### Plugins

- Plugin drafts take `.ttf` and `.otf` fonts and `.jpeg` images under `public/` too, 1 MB each, from **Upload project folder…**, **Add file…** and **Change with the assistant**. (#378)

#### Server

- The server can end a share (ADR 0012): `POST /api/shares/:shareId/end` takes every record wrapped under the share sealed again to the space's owners, then deletes the share with its members, groups' access, agents' picks and keys, and ends the public links of people who can no longer publish. `GET /api/shares/:shareId/ending` tells an owner which public links end and which publications stay, and the record scan gains a `share` scope. (#379)

#### Development

- ADR 0012 (ending a share) and ADR 0013 (merging conflicting edits) are accepted, and the merge module they build on is in `packages/client/src/merge/`. (#367, #370, #383)

## 0.25.0-beta.2 - 2026-11-09

### Highlights

#### Features

- Sign in with a passkey, with Use a passkey on the sign-in page, also when signing in the desktop app. It counts as both factors, so there’s no two-factor code. Add and remove passkeys in Settings → Security.
- Agent tools that speak MCP can use WikiStow through `wikistow mcp`, with the same commands and checks as the CLI.
- Share a plugin draft with people you name, or send a change to someone else’s plugin back to them with Propose to its owner.
- The plugin workshop keeps its conversation, versions and sample pages, so you can reload or switch devices and carry on. Drafts can hold fonts and images.
- Load development folder… works in a computer’s browser too.
- The icon picker’s Image tab offers the images already used in the space, and Shared with me shows each folder’s and space’s own look.
- Links in folder tables and query blocks open a page that moved to another space.

### Changes

#### App

- Sign in with a passkey, a fingerprint, face, screen lock or security key, with **Use a passkey** on the sign-in page, and in the browser when signing in the desktop app. It counts as both factors, so there's no two-factor code. Add, name and remove passkeys in Settings → Security; the desktop app lists and removes them. Passwords keep working, and your vault passphrase is still asked for. (#366)
- The icon picker's **Image** tab has an **In this space** row of the images already used in the space, its folders and its pages, each once. Picking one copies it, so the same picture can go on several folders or pages without uploading it again. (#360)
- **Shared with me** shows each shared folder with its own emoji, colour, icon or image, as the sidebar does, and each shared space with its tile from the rail. (#362)
- A link in a folder table or a query block to a page moved to another space opens it there, as the linking page's own link does. A query block's links also follow a renamed page now. (#369)

#### Plugins

- **Load development folder…** in Settings → Plugins works in a computer's browser too: choose a plugin's built `dist/` folder, approve it, and press **Reload** after each build. Chrome and Edge read the folder again; Firefox and Safari ask for it again at each **Reload…**. The plugin runs in that tab only, labelled Development, until you close or reload the tab or remove it, and replaces a library plugin of the same ID there. Each build goes to the server as your own development build, served only to you and dropped a week after the last Reload (migration `0042_plugin_development`). (#364)
- Plugin drafts hold fonts and images (`.woff2 .woff .png .jpg .webp .gif`, 1 MB each) under `public/`, so a theme with its own font or a plugin with an icon can be made in the workshop. **Add file…** in the workshop adds one; **Upload project folder…** and **Change with the assistant** bring them along; a build copies them as `wikistow-plugin build` does. The assistant can list and delete them, but not write them (migration `0044_draft_binary_files`). (#365)
- The plugin workshop keeps its conversation, versions and sample pages with the draft, so you can reload or switch devices and carry on. A page you copied into the preview isn't kept, only a note that you copied one. The newest version comes back to preview; older ones are listed as history. **Clear conversation** starts over on the draft's files (migration `0045_draft_workshop`). (#371)
- In the workshop, a copy of someone else's plugin offers **Propose to *owner*…**, which sends your changes back to them. They see what changed by file on their workshop page, and can open it as a draft of their own and publish it as a new version, or decline it (migration `0046_plugin_proposals`). (#372)
- Share a plugin draft with people you name, with **Share…** in the workshop. They find it under **Drafts shared with you**, can change its files and preview it, each with a conversation of their own, and only you publish it. When two people change one file, the last change wins (migration `0047_shared_drafts`). (#373)

#### CLI

- `wikistow mcp` serves the agent's commands as the tools of an MCP server, over standard input and output, for agent tools that speak MCP. Each tool runs its command with `--json`, with the same checks, idempotency keys and exit statuses. `wikistow mcp --help` says how to add it to Claude Code, Codex and other clients. (#368)

#### Releases and packaging

- Signed apt and dnf repositories for the desktop app on GitHub Pages, published after each stable release, and an update notice that says to use apt or dnf for them. (#361)

#### Development

- ADR 0013 (`docs/adr/0013-merging-conflicting-edits.md`) proposes merging a draft's conflicting edits instead of choosing one: a three-way merge of the page's Markdown by block, front matter by key, the person choosing where both changed the same block, and reviewing the merged draft before it saves. Not built yet. (#370)

## 0.25.0-beta.1 - 2026-11-08

### Highlights

#### Features

- The search box is a command palette too: type `>` first, or press Ctrl+Shift+P (Cmd+Shift+P on a Mac) or F1, then type what you want to do.
- While offline you can rename folders and change their look, delete pages and folders, move them within their space, and publish pages. The changes wait on the device and go once you’re back online.
- A page or folder moved to another space keeps its old address, which opens the new place, and its public link, at the same address.
- Owners can move or copy everything in a space into another space, with Move space into… and Copy space into… in the space menu.
- Drag a page or folder from the sidebar onto another space in the rail to move it there.
- Export… can write links between pages as relative Markdown links, for GitHub and editors that don’t read wikilinks.
- Plugins can keep settings, the same on each of your devices, and Settings → Plugins draws the settings a plugin declares. A library plugin can be turned off in one browser or on one computer only.
- App plugins can draw the search results their own way.
- The CLI can move pages and folders and rename folders, and its page history says what a change made while reading did, such as “Ticked 3”.

#### Fixes

- Mermaid diagrams now draw in the browser after an offline reload. A diagram that can’t shows its source at once, instead of “Drawing diagram…” for two minutes.

### Changes

#### App

- Mermaid diagrams now draw in the browser after an offline reload. The diagram frame's files are named by their hashes under `/assets/diagram/`, so the browser's cache keeps them, and the service worker fetches them once when it installs. A diagram that can't draw offline shows its source and says so at once, instead of "Drawing diagram…" for two minutes. (#342)
- The search box is a command palette too: type `>` first, or open it with Ctrl+Shift+P (Cmd+Shift+P on a Mac) or F1, to run what you could do where you are by typing its name. It lists the page's commands, such as Edit page, Publish, Move to… and Find on page, the space's (Export space…, and for owners Share space… and Delete space…), Lock vault, Change theme…, each plugin's settings, and the running plugins' commands under their plugin's name. Letters match in order, best matches first, then the commands you ran last, kept on this device. (#345)
- Rename a folder, change its emoji, colour or icon, and delete pages and folders while offline. They wait on the device and go once the app is back online. (#347)
- Move pages and folders within their space, by Move to… or by dragging, and publish pages, while offline. They wait on the device and go once the app is back online; a waiting publish can be cancelled from the page. Moves into or out of a shared folder, and publishing a page with a public link, still need the connection. (#354)
- **Export…** has a **Markdown links** switch, off by default, that writes links between pages as relative links to their files, `[Plan](../Work/Plan.md#next-steps)`, for GitHub and editors that don’t read wikilinks. It says how many links stayed wikilinks, such as page embeds. (#350)
- A page or folder moved to another space keeps its old address: opening it opens the new place, saying it moved, and links to it from pages left behind still open it, for people who can open it there. (#351)
- A page moved to another space keeps its public link, at the same address, where you can publish it there. The move's preview lists the links that go with it, and its public page says it's being updated until you open Share public link… there and update it. A link the move can't keep ends, as before, and the preview says why. (#355)
- Owners can move or copy everything in a space into a folder of another space, from the space menu (**Move space into…**, **Copy space into…**), with the usual preview. After a move, the space is empty and the app asks whether to delete it. (#356)
- Drag a page or folder from the sidebar onto another space in the rail to move it there: the drop opens **Move to…** with that space chosen, or **Copy to…** if you can only copy it, and nothing moves until you confirm. (#357)

#### Plugins

- Plugins can keep settings for the person, the same on each of their devices: `host.settings` (`get`, `set`, `update`, `on('changed')`), one JSON object of at most 16 KB per plugin, kept encrypted beside the plugin's approval in the account's record, or on the computer for a desktop folder install. A manifest's `settings` declares text, number, on/off and choice fields, which Settings → Plugins draws under the plugin's **Settings**, so scripts get settings without a view. Settings sections get `{ settings }`, `host.app.navigate({ kind: 'settings' })` opens the plugin's own, and the page's Plugins menu has ***Plugin* settings…**. An update keeps them and Remove deletes them. `reading-room` declares its column's width and reading speed. The library lists versions with `settings` only to apps that send `manifest=3`. (#344)
- A library plugin can be turned off in one browser or on one computer only, and stay on on your other devices: Settings → Plugins has a second switch beside **Your account**, labelled **This browser** or **This computer**. Off there, the plugin doesn't load on that device at all. It's kept on the device, and removing the plugin forgets it. (#349)
- App plugins can draw the search results their own way: `search.results` is a replaceable region, whose view gets what was typed and the app's own results, and draws only where the plugin can read every result. The search box and `>`'s commands stay the app's, and `host.app.navigate` closes search. (#352)

#### Server

- Agents can rename folders where they may edit, and moves and renames take an `Idempotency-Key`, so a retry after a lost answer gets the first answer back. (#343)

#### CLI

- `page move`, `folder move` and `folder rename` move a page or folder within its space and rename a folder, with `--json` and `--idempotency-key`. (#343)
- `page history` says what a version made by changes while reading changed, such as "Ticked 3, unticked 1", and `--json` gives it as `change`. (#346)
- `export --links markdown` writes links between pages as relative Markdown links instead of wikilinks, as the web's **Markdown links** does, and counts the wikilinks left (`wikilinks` in `--json`). (#350)

## 0.24.0 - 2026-11-07

### Highlights

#### Features

- App plugins can draw parts of the app in place of its own: the rail, a space’s home page and page tree, a folder’s page, and the text of a page as read. Settings → Plugins says which plugin draws each part, with Use the app’s own, and safe mode puts every part back.
- Plugins can work at the cursor in the draft view, reading the selection and inserting Markdown you can undo, and can add buttons to the editor’s toolbar.
- Plugins can know where you are in the app and take you to a space, folder or page, and can draw inline code such as `plugin:page-tools/rating 4` in the reader and the visual editor.
- Themes can set the colours of alerts, highlighted code, shadows and the dialog backdrop, and the sidebar’s width. Mermaid diagrams take the theme’s colours.

#### Fixes

- New page here and New folder here in a folder made offline that isn’t sent yet now work online too. The folder’s other actions, and Delete page on a page made offline, wait until it is sent, saying so, instead of failing as not found.
- Move to…, Copy to… and Publish to another space… no longer offer a folder made offline that isn’t sent yet.
- A plugin block that fails in the visual editor now shows the same note as in the reader, with Disable.

### Changes

#### App

- **New page here** and **New folder here** in a folder made offline that isn’t sent yet now save the new page or folder on the device too while online, to be sent after the folder, instead of failing as not found. That covers the moments after the server answers again, before the folder is sent, an unlock made offline the app hasn’t confirmed yet, and a folder whose sending stopped. **Create this page** from a link in a page in that folder does the same. (#291)
- The rest of that folder’s menu (Rename, Move, Share, Export, Import, Delete and the others) now waits until the folder is sent, saying so, as it already waited offline and as dragging it did, instead of failing as not found. (#291)
- A page made offline does the same: until it is sent, **Delete page** waits, saying so, instead of failing as not found. Approving the chat’s edit to a page offline now says it needs the connection. (#298)
- **Move to…**, **Copy to…** and **Publish to another space…** no longer offer a folder made offline that isn’t sent yet, and dropping something on it in the sidebar does nothing, instead of failing as not found. It shows up there once it is sent. (#307)
- The plugin workshop's preview draws its sample pages with the page's own layout, so a plugin's views show where the app puts them. Its rail items are the real ones and open the plugin's page in the preview, and a plugin's Settings sections show together, as in Settings → Plugins. (#296)
- A plugin block that fails in the visual editor now shows the same note as in the reader, naming the plugin, with **Disable**. (#295)
- Mermaid diagrams take the theme's colours, a plugin theme's too, instead of Mermaid's own light or dark look. A public copy's diagrams stay as they were. (#294)

#### Plugins

- An app plugin can claim inline code, `` `plugin:<id>/<type> <text>` ``, as it claims fenced blocks: its manifest's `inline` lists the types, and `host.inline.register` draws them in the reader and the visual editor. The page's text never changes for it. `page-tools` shows star ratings this way. `GET /api/plugins` takes `manifest=2` from apps that read such manifests, and lists versions with `inline` only to them: released apps refuse a whole listing with one. (#301)
- A theme can now set the colours of a page's alerts (`--alert-*`) and highlighted code (`--code-*`), the app's shadows and shades, the dialog backdrop, text on a destructive badge, and the sidebar's width (`--sidebar-width`). They keep today's look until a theme sets them. `ThemeToken` adds them and the banner presets (`--banner-*`), and the SDK guide lists every token. (#294)
- A plugin can now work at the cursor in the draft view. `page.editor.selection()` gives what is selected as Markdown, and `page.editor.insert(markdown)` puts Markdown there as the person's own edit, which can be undone: as text in the source editor, and in the visual editor read into the page as a paste is, with its blocks whole. A new `editor.toolbar` region puts a plugin's buttons in the editor's format toolbar, and in a bar of their own over the source editor. (#300)
- App plugins get `host.app`, in `activate` and every view: `location` says where the person is (a space, a folder, a page and its version, a plugin page, or elsewhere) and is told as it changes, also as the new `location.changed` event; `navigate` goes to a space, folder, page or one of the plugin's own pages; and `spaces.list()` gives the spaces the plugin has page access in, with their names and emoji. So a titlebar button or a Settings section can now open a page. `page.shown` now comes as a page opens, whatever draws its toolbar. (#303)
- An app plugin can draw a space's home page (with no page open) or a folder's page in place of the app's own, where it has page access: its manifest's `replaces` names them, and `host.ui.replace('space.home' | 'folder.view', { id, view })` draws them. The approval dialog says what a plugin replaces. Settings → Plugins says which plugin draws each replaced part, with **Use the app's own**, kept as the plugin's on/off is. A replacing view that fails, or draws nothing, gives the part back to the app's own with a note and **Disable**, and safe mode puts every part back. The library lists versions with `replaces` only to apps that send `manifest=2`. Several plugins in one place now always show in the order Settings lists them, also after one is turned off and on again. (#305)
- An app plugin can now draw the rail, a space's page tree (the phone's navigation drawer too) or the text of a page as read in place of the app's own, with `host.ui.replace('rail' | 'space.sidebar' | 'page.reader', …)`. The page's title, banner, toolbar and properties stay the app's, as do the space's name, menu and New page above the tree. A plugin draws the tree only in a space it can read all of. A replaced rail hides everything on it, Settings and the account menu among them, so safe mode is the way back: Ctrl+Shift+Alt+P, `?safe-mode` in a browser, or **Open without plugins** when unlocking. `host.pages.tree(spaceId)` gives a space's whole tree within the plugin's page access in one call, including what was made offline and not sent yet, and `host.app.renderMarkdown(element, markdown, { page })` draws Markdown with the app's own reader. (#306)

#### Development

- ADR 0011 (`docs/adr/0011-replaceable-regions.md`) records how plugins grow: some regions become replaceable (a space's sidebar and home, a folder's page, a page's reading view, the rail), app plugins get `host.app` for where the person is, navigation and spaces, plugins can insert Markdown at the cursor and add to the editor's toolbar, and they can claim inline code as they claim fences. It amends ADR 0001, and the glossary's **Region** and **Plugin block** change with it. (#292)
- Every plugin region is drawn through one `Place` component (`packages/ui/src/plugins/places.tsx`), from one table: `REGIONS` in the plugin SDK. History is the first `page.panel`. The SDK README's region and `data-region` tables are checked against the SDK by a test, and now list the `folder`, `workshop` and `whats-new` hooks. (#296)
- Each page is saved through one page writer (`packages/client/src/operations/page-writer.ts`), which decides between the device's queue and the server. (#293)
- What can be done offline or while a change waits is decided in one module, `packages/ui/src/shell/availability.ts`. (#298)
- Plugins' installs, approvals and access go through one `PluginStore` for the desktop's `plugins.json`, library approvals and the workshop. (#299)
- One plugin registry per activation, built with `createRuntime(store, …)`; the script worker registers through it. (#302)
- One `contentChanged` call tells the app's caches and the search index that a page changed. (#304)

#### Desktop

- A folder install set to **Use the app’s own** for a part writes that choice to `plugins.json`, which desktop apps before 0.24.0 refuse. (#305)

## 0.24.0-beta.1 - 2026-11-07

### Highlights

#### Features

- App plugins can draw parts of the app in place of its own: the rail, a space’s home page and page tree, a folder’s page, and the text of a page as read. Settings → Plugins says which plugin draws each part, with Use the app’s own, and safe mode puts every part back.
- Plugins can work at the cursor in the draft view, reading the selection and inserting Markdown you can undo, and can add buttons to the editor’s toolbar.
- Plugins can know where you are in the app and take you to a space, folder or page, and can draw inline code such as `plugin:page-tools/rating 4` in the reader and the visual editor.
- Themes can set the colours of alerts, highlighted code, shadows and the dialog backdrop, and the sidebar’s width. Mermaid diagrams take the theme’s colours.

#### Fixes

- New page here and New folder here in a folder made offline that isn’t sent yet now work online too. The folder’s other actions, and Delete page on a page made offline, wait until it is sent, saying so, instead of failing as not found.
- Move to…, Copy to… and Publish to another space… no longer offer a folder made offline that isn’t sent yet.
- A plugin block that fails in the visual editor now shows the same note as in the reader, with Disable.

### Changes

#### App

- **New page here** and **New folder here** in a folder made offline that isn’t sent yet now save the new page or folder on the device too while online, to be sent after the folder, instead of failing as not found. That covers the moments after the server answers again, before the folder is sent, an unlock made offline the app hasn’t confirmed yet, and a folder whose sending stopped. **Create this page** from a link in a page in that folder does the same. (#291)
- The rest of that folder’s menu (Rename, Move, Share, Export, Import, Delete and the others) now waits until the folder is sent, saying so, as it already waited offline and as dragging it did, instead of failing as not found. (#291)
- A page made offline does the same: until it is sent, **Delete page** waits, saying so, instead of failing as not found. Approving the chat’s edit to a page offline now says it needs the connection. (#298)
- **Move to…**, **Copy to…** and **Publish to another space…** no longer offer a folder made offline that isn’t sent yet, and dropping something on it in the sidebar does nothing, instead of failing as not found. It shows up there once it is sent. (#307)
- The plugin workshop's preview draws its sample pages with the page's own layout, so a plugin's views show where the app puts them. Its rail items are the real ones and open the plugin's page in the preview, and a plugin's Settings sections show together, as in Settings → Plugins. (#296)
- A plugin block that fails in the visual editor now shows the same note as in the reader, naming the plugin, with **Disable**. (#295)
- Mermaid diagrams take the theme's colours, a plugin theme's too, instead of Mermaid's own light or dark look. A public copy's diagrams stay as they were. (#294)

#### Plugins

- An app plugin can claim inline code, `` `plugin:<id>/<type> <text>` ``, as it claims fenced blocks: its manifest's `inline` lists the types, and `host.inline.register` draws them in the reader and the visual editor. The page's text never changes for it. `page-tools` shows star ratings this way. `GET /api/plugins` takes `manifest=2` from apps that read such manifests, and lists versions with `inline` only to them: released apps refuse a whole listing with one. (#301)
- A theme can now set the colours of a page's alerts (`--alert-*`) and highlighted code (`--code-*`), the app's shadows and shades, the dialog backdrop, text on a destructive badge, and the sidebar's width (`--sidebar-width`). They keep today's look until a theme sets them. `ThemeToken` adds them and the banner presets (`--banner-*`), and the SDK guide lists every token. (#294)
- A plugin can now work at the cursor in the draft view. `page.editor.selection()` gives what is selected as Markdown, and `page.editor.insert(markdown)` puts Markdown there as the person's own edit, which can be undone: as text in the source editor, and in the visual editor read into the page as a paste is, with its blocks whole. A new `editor.toolbar` region puts a plugin's buttons in the editor's format toolbar, and in a bar of their own over the source editor. (#300)
- App plugins get `host.app`, in `activate` and every view: `location` says where the person is (a space, a folder, a page and its version, a plugin page, or elsewhere) and is told as it changes, also as the new `location.changed` event; `navigate` goes to a space, folder, page or one of the plugin's own pages; and `spaces.list()` gives the spaces the plugin has page access in, with their names and emoji. So a titlebar button or a Settings section can now open a page. `page.shown` now comes as a page opens, whatever draws its toolbar. (#303)
- An app plugin can draw a space's home page (with no page open) or a folder's page in place of the app's own, where it has page access: its manifest's `replaces` names them, and `host.ui.replace('space.home' | 'folder.view', { id, view })` draws them. The approval dialog says what a plugin replaces. Settings → Plugins says which plugin draws each replaced part, with **Use the app's own**, kept as the plugin's on/off is. A replacing view that fails, or draws nothing, gives the part back to the app's own with a note and **Disable**, and safe mode puts every part back. The library lists versions with `replaces` only to apps that send `manifest=2`. Several plugins in one place now always show in the order Settings lists them, also after one is turned off and on again. (#305)
- An app plugin can now draw the rail, a space's page tree (the phone's navigation drawer too) or the text of a page as read in place of the app's own, with `host.ui.replace('rail' | 'space.sidebar' | 'page.reader', …)`. The page's title, banner, toolbar and properties stay the app's, as do the space's name, menu and New page above the tree. A plugin draws the tree only in a space it can read all of. A replaced rail hides everything on it, Settings and the account menu among them, so safe mode is the way back: Ctrl+Shift+Alt+P, `?safe-mode` in a browser, or **Open without plugins** when unlocking. `host.pages.tree(spaceId)` gives a space's whole tree within the plugin's page access in one call, including what was made offline and not sent yet, and `host.app.renderMarkdown(element, markdown, { page })` draws Markdown with the app's own reader. (#306)

#### Development

- ADR 0011 (`docs/adr/0011-replaceable-regions.md`) records how plugins grow: some regions become replaceable (a space's sidebar and home, a folder's page, a page's reading view, the rail), app plugins get `host.app` for where the person is, navigation and spaces, plugins can insert Markdown at the cursor and add to the editor's toolbar, and they can claim inline code as they claim fences. It amends ADR 0001, and the glossary's **Region** and **Plugin block** change with it. (#292)
- Every plugin region is drawn through one `Place` component (`packages/ui/src/plugins/places.tsx`), from one table: `REGIONS` in the plugin SDK. History is the first `page.panel`. The SDK README's region and `data-region` tables are checked against the SDK by a test, and now list the `folder`, `workshop` and `whats-new` hooks. (#296)
- Each page is saved through one page writer (`packages/client/src/operations/page-writer.ts`), which decides between the device's queue and the server. (#293)
- What can be done offline or while a change waits is decided in one module, `packages/ui/src/shell/availability.ts`. (#298)
- Plugins' installs, approvals and access go through one `PluginStore` for the desktop's `plugins.json`, library approvals and the workshop. (#299)
- One plugin registry per activation, built with `createRuntime(store, …)`; the script worker registers through it. (#302)
- One `contentChanged` call tells the app's caches and the search index that a page changed. (#304)

#### Desktop

- A folder install set to **Use the app’s own** for a part writes that choice to `plugins.json`, which desktop apps before 0.24.0 refuse. (#305)

## 0.23.0 - 2026-11-06

### Highlights

#### Upgrade notes

- New versions now go out as a beta first. To try them early, use the `:beta` server image, or `wikistow-desktop-beta-bin` and `wikistow-cli-beta-bin` from the AUR, which install beside the stable app and CLI as WikiStow Beta and `wikistow-beta`.

#### Features

- Pages work offline. The browser keeps the pages you open, and the desktop app every page, sealed on the device. Settings → Keep for offline chooses which.
- With no connection the app still starts, unlocks and shows kept pages, with Offline in the rail and when each page is from. Search and Linked from work over what’s kept.
- You can edit drafts and make pages and folders offline. Changes are kept on the device and saved once the server answers. A page someone changed meanwhile shows the usual conflict.
- The browser app can be installed on phones and computers, and loads without a connection once opened online.
- Import… also takes an Obsidian vault, as its folder or a zip of it. Agents can import one with `wikistow import`.
- Ctrl+F (Cmd+F on a Mac), or Find on page in a page’s menu, finds text on the page you’re on, and while you edit, replaces it.

#### Fixes

- When the server can’t be reached or doesn’t answer as WikiStow, the app shows a screen naming it, with Try again, instead of “Something went wrong!”. In the desktop app, Sign out on this computer gets you to another server.
- A click outside the Import dialog no longer closes it, which stopped an import partway and left its pages empty. Stopping now asks first, and says how many pages are still empty drafts: import again to finish them.

#### Maintenance

- The desktop app runs on Electron 44.10.2.

### Changes

#### App

- The browser app can be installed on phones and computers, and once opened online it loads without a connection. A service worker keeps the app's own files only, never pages or anything from your account. (#261)
- Import… also reads an Obsidian vault, as its folder or a zip of it: each folder that holds notes becomes a folder, each note a published page titled by its file name, and the files its notes link to or embed attachments of their pages. Links resolve as Obsidian resolves them, and files no note names are listed in the report. (#260)
- Pages are now kept on the device, sealed for you, for reading offline: in the browser the pages you open, in the desktop app every page. Settings → Keep for offline changes which, and shows how much is kept. Pages kept load from the device instead of the server. Signing out deletes them. (#263)
- Pages kept on the device stay readable when the server stops answering. The rail shows Offline, each page says when it is from, and search and Linked from work over what’s kept. A page that isn’t kept says so. Anything that needs the server is dimmed and says Needs the connection, and everything loads again once the server answers. (#264)
- The app starts and unlocks without a connection. With the server away, the browser app loads, opens the vault it kept or asks for your passphrase, and reads the kept pages; the desktop app does the same when it keeps your session in a keyring. If you changed your passphrase on another device, the old one still works offline, and once the server answers the app locks and asks for the new one. The browser now keeps its trust marks between visits, as the desktop app does, so it warns about an older contacts record from the server after a reload too. (#265)
- You can edit drafts and make pages and folders without a connection. Changes are saved on the device, marked in the sidebar, and sent once the server answers. A page someone changed meanwhile comes back as the usual conflict, and one deleted or out of reach offers Try again, Save as a new page in my space, Copy text or Discard. Signing out, or signing in as someone else, warns first while changes wait. (#266)
- When the server can’t be reached or doesn’t answer as WikiStow, the app shows a screen of its own that names the server, with Try again, in place of the router’s “Something went wrong!”. (#262)
- The Import dialog stays open when you click outside it. While it imports, Cancel, Escape and the close button ask Stop importing? first, and a stopped import says how many pages are still empty drafts, which importing again finishes. A spinner shows while it works. The CLI's `wikistow import` also gives that count when stopped. (#274)
- Find on page: Ctrl+F (Cmd+F on a Mac), or **Find on page** in the page’s menu, opens a find bar over a page. It highlights every match in the page’s title and body as you type and says which one you’re on. Enter and Shift+Enter go to the next match and the one before, and Escape closes the bar, leaving the match selected. While editing, in the source or the visual editor, **Replace** and **Replace all** change matches as ordinary edits you can undo. It leaves out the page’s properties, and text in diagrams and plugin blocks. The page’s menu now shows for readers too. (#277)

#### Desktop

- On the beta channel, the update notice offers betas: a beta build, or one installed with `wikistow-desktop-beta-bin`, is offered the newest release of any kind, and other builds the newest stable one, as before. (#259)
- When the server is gone, for example because its address moved, that screen and Sign out both offer Sign out on this computer. It forgets the session, the remembered unlock, the kept files and the server here, then asks for a server, so you can sign in to another. The session stays open on the old server until it expires or you sign it out under Settings → Desktop apps. (#262)
- The beta desktop app signs in through the browser's `wikistow-beta://` link. (#271)
- The Mac app’s Edit menu has **Find…** (Cmd+F), which opens Find on page. (#277)

#### CLI

- `wikistow import` takes an Obsidian vault too, and `--from obsidian|joplin` for files that don't say which app they came from. (#260)

#### Releases and packaging

- Each version goes out as a beta first, then as a stable release. Every release from `main` also tags its server image `beta` and publishes `wikistow-desktop-beta-bin` and `wikistow-cli-beta-bin` to the AUR; stable releases still publish `wikistow-desktop-bin` and `wikistow-cli-bin`. (#259)
- Each push to `main` also tags its server image `main`, which moves to the newest `main` build, for a test server that follows it. (#256)
- The AUR's `wikistow-desktop-beta-bin` installs beside `wikistow-desktop-bin` instead of replacing it. It is **WikiStow Beta** in the launcher, with a violet icon, and keeps its own sign-in, settings and data in `~/.config/WikiStow Beta`. It signs in through `wikistow-beta://` links, which the server's sign-in page now sends when the beta asks. (#268)
- The AUR's `wikistow-cli-beta-bin` installs beside `wikistow-cli-bin` instead of replacing it, as the command `wikistow-beta`. It keeps its files in `~/.config/wikistow-beta`, so enroll it as an agent of its own, and its help, messages and `skill` name `wikistow-beta`. (#270)
- Electron 44.10.2, from 44.10.1. (#269)

#### Development

- The source editor's completion tests wait for a list Enter can accept. Just after a keystroke, CodeMirror shows the last list disabled, and Enter then made a new line. (#273)
- Test runs no longer leave Postgres databases behind. The Playwright configs stop the e2e server with `SIGTERM`, so it drops its database; before, Playwright `SIGKILL`ed it. Test databases carry their creation time in their name, and each run first drops those of its kind left more than a day ago, by a run that was killed, if nothing is connected to them. (#279)

## 0.23.0-beta.5 - 2026-11-04

### Highlights

#### Upgrade notes

- This is a beta, on the beta channel only: the `:beta` server image and `wikistow-desktop-beta-bin` / `wikistow-cli-beta-bin` on the AUR. Stable installs stay on 0.22.0.

#### Features

- Ctrl+F (Cmd+F on a Mac), or Find on page in a page’s menu, finds text on the page you’re on, and while you edit, replaces it.

### Changes

#### App

- Find on page: Ctrl+F (Cmd+F on a Mac), or **Find on page** in the page’s menu, opens a find bar over a page. It highlights every match in the page’s title and body as you type and says which one you’re on. Enter and Shift+Enter go to the next match and the one before, and Escape closes the bar, leaving the match selected. While editing, in the source or the visual editor, **Replace** and **Replace all** change matches as ordinary edits you can undo. It leaves out the page’s properties, and text in diagrams and plugin blocks. The page’s menu now shows for readers too. (#277)

#### Desktop

- The Mac app’s Edit menu has **Find…** (Cmd+F), which opens Find on page. (#277)

## 0.23.0-beta.4 - 2026-11-04

### Highlights

#### Upgrade notes

- This is a beta, on the beta channel only: the `:beta` server image and `wikistow-desktop-beta-bin` / `wikistow-cli-beta-bin` on the AUR. Stable installs stay on 0.22.0.

#### Fixes

- A click outside the Import dialog no longer closes it, which stopped an import partway and left its pages empty. Stopping now asks first, and says how many pages are still empty drafts: import again to finish them.

### Changes

#### App

- The Import dialog stays open when you click outside it. While it imports, Cancel, Escape and the close button ask Stop importing? first, and a stopped import says how many pages are still empty drafts, which importing again finishes. A spinner shows while it works. The CLI's `wikistow import` also gives that count when stopped. (#274)

## 0.23.0-beta.3 - 2026-11-04

### Highlights

#### Upgrade notes

- This is a beta, on the beta channel only: the `:beta` server image and `wikistow-desktop-beta-bin` / `wikistow-cli-beta-bin` on the AUR. Stable installs stay on 0.22.0.
- The beta CLI from the AUR now installs beside the stable one as `wikistow-beta`, with its own enrollment. Enroll it again with `wikistow-beta agent enroll`.

#### Fixes

- The beta desktop app can sign in: 0.23.0-beta.2 ignored the link the browser hands back.

### Changes

#### Desktop

- The beta desktop app signs in: it takes the browser's `wikistow-beta://` link, which it ignored in 0.23.0-beta.2. (#271)

#### Releases and packaging

- The AUR's `wikistow-cli-beta-bin` installs beside `wikistow-cli-bin` instead of replacing it, as the command `wikistow-beta`. It keeps its files in `~/.config/wikistow-beta`, so enroll it as an agent of its own, and its help, messages and `skill` name `wikistow-beta`. If you had the beta CLI before, its command is now `wikistow-beta` and it starts unenrolled: its old enrollment stays in `~/.config/wikistow`, which the stable `wikistow` uses. (#270)

#### Development

- The source editor's completion tests wait for a list Enter can accept. Just after a keystroke, CodeMirror shows the last list disabled, and Enter then made a new line. (#273)

## 0.23.0-beta.2 - 2026-11-04

### Highlights

#### Upgrade notes

- This is a beta, on the beta channel only: the `:beta` server image and `wikistow-desktop-beta-bin` / `wikistow-cli-beta-bin` on the AUR. Stable installs stay on 0.22.0.
- The beta desktop app from the AUR now installs beside the stable one, as WikiStow Beta with a violet icon. It keeps its own sign-in and settings, so sign in to it again. It signs in only to servers from this release on.

#### Maintenance

- The desktop app runs on Electron 44.10.2.

### Changes

#### Releases and packaging

- The AUR's `wikistow-desktop-beta-bin` installs beside `wikistow-desktop-bin` instead of replacing it. It is **WikiStow Beta** in the launcher, with a violet icon, and keeps its own sign-in, settings and data in `~/.config/WikiStow Beta`. It signs in through `wikistow-beta://` links, which the server's sign-in page now sends when the beta asks. If you had the beta before, its sign-in and settings stay with the stable app's in `~/.config/WikiStow`: sign in to the beta again. (#268)
- Electron 44.10.2, from 44.10.1. (#269)

## 0.23.0-beta.1 - 2026-11-03

### Highlights

#### Upgrade notes

- This is a beta, on the beta channel only: the `:beta` server image and `wikistow-desktop-beta-bin` / `wikistow-cli-beta-bin` on the AUR. Stable installs stay on 0.22.0.

#### Features

- Pages work offline. The browser keeps the pages you open, and the desktop app every page, sealed on the device. Settings → Keep for offline chooses which.
- With no connection the app still starts, unlocks and shows kept pages, with Offline in the rail and when each page is from. Search and Linked from work over what’s kept.
- You can edit drafts and make pages and folders offline. Changes are kept on the device and saved once the server answers. A page someone changed meanwhile shows the usual conflict.
- The browser app can be installed on phones and computers, and loads without a connection once opened online.
- Import… also takes an Obsidian vault, as its folder or a zip of it. Agents can import one with `wikistow import`.

#### Fixes

- When the server can’t be reached or doesn’t answer as WikiStow, the app shows a screen naming it, with Try again, instead of “Something went wrong!”. In the desktop app, Sign out on this computer gets you to another server.

### Changes

#### App

- The browser app can be installed on phones and computers, and once opened online it loads without a connection. A service worker keeps the app's own files only, never pages or anything from your account. (#261)
- Import… also reads an Obsidian vault, as its folder or a zip of it: each folder that holds notes becomes a folder, each note a published page titled by its file name, and the files its notes link to or embed attachments of their pages. Links resolve as Obsidian resolves them, and files no note names are listed in the report. (#260)
- Pages are now kept on the device, sealed for you, for reading offline: in the browser the pages you open, in the desktop app every page. Settings → Keep for offline changes which, and shows how much is kept. Pages kept load from the device instead of the server. Signing out deletes them. (#263)
- Pages kept on the device stay readable when the server stops answering. The rail shows Offline, each page says when it is from, and search and Linked from work over what’s kept. A page that isn’t kept says so. Anything that needs the server is dimmed and says Needs the connection, and everything loads again once the server answers. (#264)
- The app starts and unlocks without a connection. With the server away, the browser app loads, opens the vault it kept or asks for your passphrase, and reads the kept pages; the desktop app does the same when it keeps your session in a keyring. If you changed your passphrase on another device, the old one still works offline, and once the server answers the app locks and asks for the new one. The browser now keeps its trust marks between visits, as the desktop app does, so it warns about an older contacts record from the server after a reload too. (#265)
- You can edit drafts and make pages and folders without a connection. Changes are saved on the device, marked in the sidebar, and sent once the server answers. A page someone changed meanwhile comes back as the usual conflict, and one deleted or out of reach offers Try again, Save as a new page in my space, Copy text or Discard. Signing out, or signing in as someone else, warns first while changes wait. (#266)
- When the server can’t be reached or doesn’t answer as WikiStow, the app shows a screen of its own that names the server, with Try again, in place of the router’s “Something went wrong!”. (#262)

#### Desktop

- On the beta channel, the update notice offers betas: a beta build, or one installed with `wikistow-desktop-beta-bin`, is offered the newest release of any kind, and other builds the newest stable one, as before. (#259)
- When the server is gone, for example because its address moved, that screen and Sign out both offer Sign out on this computer. It forgets the session, the remembered unlock, the kept files and the server here, then asks for a server, so you can sign in to another. The session stays open on the old server until it expires or you sign it out under Settings → Desktop apps. (#262)

#### CLI

- `wikistow import` takes an Obsidian vault too, and `--from obsidian|joplin` for files that don't say which app they came from. (#260)

#### Releases and packaging

- Each version goes out as a beta first, then as a stable release. Every release from `main` also tags its server image `beta` and publishes `wikistow-desktop-beta-bin` and `wikistow-cli-beta-bin` to the AUR; stable releases still publish `wikistow-desktop-bin` and `wikistow-cli-bin`. (#259)
- Each push to `main` also tags its server image `main`, which moves to the newest `main` build, for a test server that follows it. (#256)

## 0.22.0 - 2026-11-02

### Highlights

#### Features

- Deleting a page or folder moves it to its space’s trash for 30 days. Trash in the rail lists what you deleted in the spaces you own, to restore or delete for good, and Undo puts back what you just deleted.
- Linked from, below each page, lists the pages in its space that link to it. Agents get the same list with `wikistow page links`.
- Math in pages: `$…$` inline and `$$` blocks show as math in the reader, the visual editor and public pages. Prices like `$5 and $10` stay text.
- A `mermaid` code block shows as its diagram, with a button to see its source.
- Import… in the space and folder menus brings in notes from Joplin, from a JEX file or a Markdown + Front Matter export. Agents can import with `wikistow import`.
- The desktop app for Windows, x64 and Arm: download the installer from the release and run it. It isn’t signed yet, so Windows asks first: choose More info, then Run anyway.
- The desktop app for macOS, for Apple silicon and Intel: download the zip for your Mac from the release. It isn’t signed by an Apple developer, so the first time it opens, allow it under System Settings, Privacy & Security, Open Anyway.

#### UI polish

- A page’s properties start collapsed to one line, such as “Properties · 12”, which opens them. Show properties in Settings, under Pages, starts them open instead.

### Changes

#### App

- A page’s properties start collapsed to one line, "Properties · 12", which opens them, in the reader and the draft view. Each page remembers whether you opened or closed them on this device, and Show properties in Settings, under Pages, starts them open instead. (#246)
- Deleting a page or folder moves it, with everything in it, to its space's trash for 30 days. Trash in the rail lists what was deleted in the spaces you own, with who deleted it and when, to restore or delete for good, and Empty trash clears it. After a delete, Undo puts it back. A restored page or folder comes back with its versions, attachments, shares and published state; its public link stays off. (#249)
- Linked from, below each page in the reader and the draft view, lists the pages in its space that link to it, by title with their folders. It shows only pages you can open, in the version you see, with drafts labelled for editors, and nothing when no page links there. (#248)
- Math in pages: `$…$` inline and `$$` blocks show as MathML in the reader and the visual editor, where a click opens the TeX to edit. A single dollar follows Pandoc's rule, so prices like `$5 and $10` stay text. (#252)
- A fenced `mermaid` code block shows as its diagram in the reader and under its code in the visual editor, with a button to see the source. Mermaid runs in a sandboxed frame and loads only on pages with a diagram. A public page shows each diagram as an image, with its source under it. (#253)
- Import… in the space menu and each folder's menu, beside Export…, brings in notes from Joplin: a JEX file, or a Markdown + Front Matter export's folder or zip. Each notebook becomes a folder and each note a published page, with its files as attachments, its tags, dates and to-do state as front matter, and links between notes as wikilinks. It shows how far it has got, can stop, and lists links it couldn't rewrite and notes it left out, such as encrypted ones. Importing the same export into the same place again makes nothing twice and finishes an import cut short. (#254)

#### CLI

- `wikistow page links PAGE_ID` lists the pages that link to a page, from what the agent can read, as the app's Linked from does. (#248)
- `wikistow import PATH`, with `--space SPACE_ID`, `--folder FOLDER_ID` or both, imports a Joplin export as Import… does, for agents that may publish there. The skill says to use it only when the person asks. (#254)

#### Desktop

- The desktop app runs on Windows 10 and 11, keeping its sign-in, remembered unlock, search index and trust marks sealed with DPAPI, with its data in `%APPDATA%\WikiStow Desktop`, apart from the CLI's. The update notice links to the new installer (#250).
- The desktop app for macOS, for Apple silicon and Intel. It has a menu bar (WikiStow, Edit, View, Window), Cmd shortcuts, and the system's window buttons in the titlebar, keeps its sign-in in the login Keychain, and takes `wikistow://` sign-in links. It isn't signed by an Apple developer, so macOS asks you to allow it under Privacy & Security the first time it opens. (#247)

#### Releases and packaging

- Each release has unsigned Windows installers, `wikistow-desktop-<version>-x64-setup.exe` and `…-arm64-setup.exe`, built on Linux with NSIS and checked on Windows x64 and Arm runners. CI can be started by hand to build and check the desktop packages on a branch (#250).
- Each release has `wikistow-desktop-<version>-macos-arm64.zip` and `…-macos-x64.zip`, checked in `SHA256SUMS`, built and started on a Mac of each kind in CI. A stable release also updates the Homebrew cask in the `skint007/wikistow` tap: `brew install --cask skint007/wikistow/wikistow`. (#247)

#### Server

- Public pages show math too, and copies made before are rendered again. (#252)
- A public page shows an image at the width the page gives it, as the app does, so public pages are rendered again once after the update. (#253)

## 0.21.0 - 2026-10-31

### Highlights

#### Features

- A Checklist button in the visual editor’s toolbar, beside Bulleted list and Numbered list, makes a list of tasks to tick, with Ctrl+Alt+9.
- Select text and type a bracket or quote to wrap it, in both editors. In the visual editor `*` makes it italic, twice bold, `` ` `` inline code, `~` strikethrough, and `[` twice a wikilink.
- Several cursors in Markdown mode, as in VS Code: Ctrl+Alt+Up or Down adds one (Shift+Alt+Up or Down on Linux), Alt+drag selects a column, Ctrl+click adds one, Ctrl+D selects the next match, and Escape goes back to one.
- An uploaded banner image can be up to three times taller and fade into the page, with Height and Fade under Focal point in the Banner picker.
- A page’s history says what a change made while reading did, such as “Ticked 3, unticked 1” or “Changed servings”, and folds a run of them into one row. It lists 20 versions at a time, with Show older versions for more.

#### Fixes

- In the visual editor, Enter after a ticked task starts an unticked one.

#### Maintenance

- Dependencies with published security advisories are updated, and the desktop app runs on Electron 44.10.1.

### Changes

#### App

- An uploaded banner image can be taller, up to three times the usual band, and fade into the page, with new Height and Fade sliders under Focal point in the Banner picker. Public pages show both. (#228)
- History says what changed in a version made by ticking tasks, or changing a value a block sets, while reading the page, such as "Ticked 3, unticked 1" or "Changed servings". A run of those versions by one person folds into one row, with a button to show the rest. History lists the newest 20 versions, with Show older versions for more. Such a version holds the payload extension `wikistow.change` (ADR 0008). (#234)
- Several cursors in Markdown mode, as in VS Code: Ctrl+Alt+Up or Down adds a cursor above or below (also Shift+Alt+Up or Down on Linux, where copying a line moves to Ctrl+Shift+Alt+Up or Down), Alt+drag selects a column, Ctrl+click adds a cursor, Ctrl+D adds the next match, and Escape goes back to one. Cmd for Ctrl on a Mac. (#229)
- In Markdown mode, typing a bracket, quote, `*`, `_` or `~` over selected text wraps it, as in VS Code, rather than replacing it. Typing `*` twice makes it bold. Brackets still don't close themselves as you type. (#232)
- Checklist in the visual editor's toolbar, next to Bulleted list and Numbered list, with Ctrl+Alt+9 (⌘⌥9 on a Mac). It makes a list of unticked tasks, turns a bulleted or numbered list into one, and takes items out of one. Bulleted list and Numbered list take the boxes off a checklist. (#230)
- Typing a bracket or quote over selected text in the visual editor wraps the text instead of replacing it. Typing `*` or `_` makes it italic, twice bold, `` ` `` makes it inline code, `~` strikethrough, and `[` twice a wikilink. (#233)
- In the visual editor, Enter after a ticked task makes an unticked one, as it does after an unticked task. Before, the new task was ticked too. (#235)

#### Development

- Dependencies with security advisories: undici 7.30.1, from 7.30.0, which Electron's downloader uses; `smtp-server` 3.21.3 and `mailparser` 3.14.1, from 3.19.16 and 3.9.36, in the e2e mail server, with nodemailer 10.3.1; and overrides giving `micromark-extension-math` KaTeX 0.18.10 and drizzle-kit's `@esbuild-kit` loader esbuild 0.25.12, the copies the rest of the tree has, since their own ranges stop at KaTeX 0.16 and esbuild 0.18. (#236)

#### Releases and packaging

- Electron 44.10.1, from 44.10.0. (#237)

## 0.20.0 - 2026-10-30

### Highlights

#### Features

- Move a page or folder into another space, or copy one anywhere you can make pages, this space included, with Move to… and Copy to… in its menus, where Move… was. Each page brings its current draft and published version, and links between the pages that go together keep working.
- Agents can copy pages and folders too, with `wikistow page copy` and `wikistow folder copy`. They copy only within what they were picked for, and never move.

### Changes

#### App

- Move… is now Move to…, beside a new Copy to…, in the page menu and the sidebar’s folder and page menus. Their dialog picks a space above the folder. A move within the space is the move it was. A copy, or an owner’s move into another space, first shows who can open it there, who loses access, pages that arrive unpublished because you can’t publish there, and links that won’t find their page; a move also lists the pages left linking to it and what it ends: public links, publications, shares and their members, agent picks and earlier versions. A move between spaces always asks, even with asking before moves turned off. The dialog shows how far it has got, can stop, and opens what it made. Editors who aren’t owners are told only owners move into another space, and offered a copy. A page published here from another page stops a copy until it is detached, and the dialog names it. (#221)

#### Server

- Copies and moves between spaces (ADR 0007). `POST /api/copies` opens a copy of a page or folder, with everything under it, as hidden nodes under a destination folder or the top of a space. `POST /api/copies/:copyId/records` takes each node's records, sealed again for the destination, in batches. `POST /api/copies/:copyId/finish` shows them, and for a move, deletes the source in the same transaction, if its pages and folders haven't changed since they were sealed. `DELETE /api/copies/:copyId` cancels. Moves are for people who own the source space; copies are for anyone who can edit it, agents included. A finished copy answers a repeated finish or cancel as the first did for a day, and one left unfinished is deleted a day after its last request. Hidden nodes are in no tree, read or search. The audit log records `node.moved-between-spaces` and `node.copied`. (#219)

#### CLI

- `wikistow page copy PAGE_ID` and `wikistow folder copy FOLDER_ID`, with `--space SPACE_ID`, `--folder FOLDER_ID` or both, copy a page, or a folder with everything in it, as new ones into a folder of any space the agent may make pages in, or the top of its share there. Each page brings its current draft and published version and their files. Pages arrive published only where the agent and its person may publish, and the output names the rest. It prints the new page's or folder's ID and space, and how many pages and folders were copied. An agent copies and never moves. With `--idempotency-key`, a retry finds the first run's copy once it finished, rather than making a second, and copies again if it was cancelled; one the server still holds open asks for a new key. Ctrl-C cancels a copy not yet finished. The skill says to copy only what the person asks for. (#223)

#### Development

- ADR 0007 (`docs/adr/0007-move-and-copy-between-spaces.md`) records how pages and folders move and copy between spaces: a copy seals each page's current draft and published version, and each folder's name and look, again as new hidden nodes at the destination, and a move between spaces is a copy that deletes its source when it finishes. Protocol section 10 gains *Copies, and moves between spaces*, and the spec's sharing rule, capability table and glossary (**Copy**) change with it. (#218)
- `copyOperations` in the client: `previewCopy` works out who gains and loses access, pages arriving unpublished, links that won't work and what a move ends, sealing nothing, and can take the IDs the copy makes; `makeCopy` seals each node again for the destination, rewrites link-table entries and `/s/…/p/…` and `/s/…/f/…` addresses between copied pages, sends in batches under the body and entry limits, waits out `Retry-After`, stops on a signal, reseals pages a move's finish names as changed, and throws `CopyKept` when it leaves a copy for its finish; `cancelCopy` cancels one. (#220)

## 0.19.0 - 2026-10-29

### Highlights

#### Features

- Tick a page’s task list while reading it, without opening the draft. A few seconds after the last tick, the page is published with them, all as one new version. Only people who can publish the page can tick it, and only while its draft has no unpublished changes and the page has no public link.
- Plugin blocks can change a page’s properties, and every `=key` showing them follows. A calculator’s Servings field can be tied to `servings`, in the visual editor and, for people who can publish the page, while reading it, published as ticks are.

### Changes

#### App

- A published page’s task checkboxes tick for an editor who can publish it. Ticks wait for a pause of about three seconds, at most fifteen, or for leaving the page, then go into the draft and are published together as one version. Each changes only the character in its box, found again by its text if the page changed meanwhile; one that no longer applies is left out, and the page says so. If the draft has unpublished changes, or the page has a public link (whose copy every publish ends), the boxes stay disabled, with a hint saying why, and a tick that meets either goes into the draft only. Readers’ boxes stay read-only. (#214)

#### Plugins

- A plugin block’s view gets the page’s properties, and `setProperty(key, value)`, which changes only that value in the frontmatter: as the person’s edit in the visual editor, and in the reader through the same queue as ticks, under the same rules, else null. An app plugin’s view is drawn again as the properties change, but not for its own change; a script’s form takes them in place, keeping the field being typed in. A script block’s number or text field can name a `property`: it shows the page’s value, and sets it once a valid value typed into it is committed, on blur or Enter, without writing its fence line. A field tied to a list shows it read-only. The calculator example gains a recipe block that scales an amount to the page’s servings. The plugin API stays version 1, and plugins built with this SDK still load in older apps. (#215)

## 0.18.1 - 2026-10-29

### Highlights

#### Fixes

- A space with a long list of pages no longer lets the whole window scroll past the bottom of the app. Only the page list scrolls.

### Changes

#### App

- A long page list scrolls in the sidebar alone. Before, the window could also scroll, past the bottom of the app, because the list didn't clip its rows' screen-reader text. (#210)

## 0.18.0 - 2026-10-28

### Highlights

#### Upgrade notes

- A page shared with a public link before this version shows its banner and its emoji, image or icon there once it’s published again. Until then, its public page shows the theme’s banner and no badge.

#### UI polish

- A page shared with a public link looks like it does in the app: its colours, light or dark as the reader’s system is, its font, and its banner and emoji, image or icon. Wide screens list its headings beside it.

### Changes

#### App

- A public page’s copy goes up with the page’s cover: its emoji, its icon from the set, its banner preset or image with its focal point, and its image, those images ahead of the body’s. (#205)

#### Server

- Public pages use the app’s light palette, and slate where the reader’s system is dark, Nunito, and the reader’s styles, with the page in a card under its cover and badge. Under the title they say when the copy went up and how long it takes to read, and from 960px wide they list the page’s h2 and h3 headings beside the card. Their policy allows fonts from the server, which the web build writes under `/fonts/`. Existing copies are rendered again when the server starts, and show the theme’s banner and no badge until the page is published again or **Update public page** is used. (#205)

#### Development

- The property tests wait out ProseMirror’s caret check after focusing the editor before they type, which fixes a flaky **Insert in page** test. (#206)
- The deep-folder timing test in `query.test.ts` takes the fastest of 15 rounds and allows 24 times as long for 8 times the folders, as the other timing tests do, which fixes a flaky failure on busy runners. (#207)

#### Releases and packaging

- Electron 44.10.0, from 44.9.3. (#208)

## 0.17.0 - 2026-10-25

### Highlights

#### Features

- A page’s properties show as rows above its body, each value as what it is: tags as pills, a checkbox, a date, a link. On a draft you edit them in place, and only the characters you change move in the frontmatter, so notes from Obsidian keep their comments and layout.
- Show a property’s value in the page with inline code: `=servings` for this page’s, or `=[[Garlic bread]].cook_time` for another page’s, which keeps working when that page is renamed.
- Search finds pages by their properties: type `tag:soup` or `status:"in progress"`, alone or with words, or click a tag in a page’s properties.
- List pages by their properties with a `wikistow-query` block: say where they are, which must hold, which values to show and how to sort them, and the page shows a table that keeps up as pages change.
- Open a folder to see its pages as a list or a table of their properties, and change a value right in its cell. Clicking a folder’s name in the sidebar now opens it, where it used to only open or close it in the tree; its arrow still does that.

#### Fixes

- Hints on links open above the link, where the pointer no longer covers them.
- A template with a very long run of spaces in a `{{variable}}` no longer holds up the template dialog.

#### Optimizations

- Search, query tables and folder tables take in a change by reading again only the pages it touched, rather than rebuilding the whole search index after every save.

#### Maintenance

- Nodemailer, which sends the server’s mail, is updated for three published advisories in how it reads addresses.

### Changes

#### App

- Search, query tables, folder tables and other pages' values keep up with a change by reading again only what it touched, rather than rebuilding the whole search index: your own saves go in as written without asking the server, a change someone else makes lists only its space and opens only the pages that changed, and the server's word of your own save changes nothing. A tab coming back into view updates the index once, rather than twice. The desktop app writes its kept index once your saves pause, rather than after each, and at once when anything leaves the index, as when access to a page is lost. (#199)
- In the visual editor, inline code on both sides of a link's edge, or of where bold, italic or strikethrough starts or ends, read as one reference, where the reader reads two. So `` [`=a `](https://example.com)`=servings` `` showed no value, and italicizing part of `` `=servings` `` kept its value. The editor now reads them as the reader does. (#201)
- The hints on a link's own text open above it, as a link's hint does, instead of below, where the pointer covered them: **No page has this title yet** in the visual editor, **Create this page** and **More than one page has this title** in the reader, the ambiguous-title hint on a wikilink inside a Markdown link in the visual editor, a property's page link that finds no page or several, a tag pill's **Search tag:…**, and a reference's (`=key`) wherever it's drawn on a link's text, a page link it shows included. The **?** and **✓** buttons that choose a page keep their hints below. (#201)
- Reading a template's `{{variables}}` takes time linear in its length. A long run of spaces after `{{name`, or a line of many `{{name|` that no `}}` closes, took time quadratic in it: a template with 64 KiB of spaces after `{{name` held up the template dialog for over a second when it was picked, and again when the page was made. The same variables are read as before. (#198)
- A property reference, a template variable or a search filter can name a key written with combining marks, such as `=मूल्य`, `{{ราคาที่ดี}}` or `मूल्य:40`, and a name with an accent typed apart from its letter finds the key typed with it, and the other way round. Both editors complete such names too. (#197)
- In the visual editor, the hint showing a wikilink's source opens above it, as a link's hint does, instead of below, where the pointer covered it. (#194)
- A fenced code block labelled `wikistow-query` lists pages as a table: `from` a folder or `#tag`, `where` conditions (`=`, `!=`, `<`, `<=`, `>`, `>=`, `has`; numbers and dates compare as such), `show` columns, `sort` a key or `title`, and `limit`. The table runs over your own search index, so it lists only pages you can open, and updates as they change. A block that doesn't read shows as code with a line saying why. The visual editor keeps the block as code and shows the table under it. Dataview blocks stay code. A public link's copy holds the table as it stood at publish, from published versions only, linking only pages with a public link of their own, and the public link dialog says the page lists other pages. (#193)
- A folder opens to its pages, as a list or a table of their properties: click its name in the sidebar, or **Open** in its menu, and its chevron still just opens or closes it there. The table's columns are the keys the pages use, which you can hide, and the list or table choice is kept per folder on this device. Readers see published values, and editors their drafts, labelled. Editors change a value in its cell, which saves that page's draft changing only that value; if someone saved the page since, the cell says so and nothing is overwritten. On phones the list comes first, and the table scrolls sideways. (#192)
- Clicking a tag in a page's properties opens search for that tag, on the published page and the draft, without leaving the page. On the draft, a tag's × still removes it. (#191)
- Search finds pages by their properties: `tag:soup` for a tag, and `key:value` for any property, quoted when the value has spaces (`status:"in progress"`), alone or with words. An address ending `#search=` and a query opens search with it. (#187)
- Inline code `=[[Garlic bread]].cook_time` shows another page's `cook_time`, from the version of that page you see, with a hint naming the property and the page. The link follows a rename like any wikilink, and a property whose value is one page link, such as `goes_with: "[[Tomato soup]]"`, now does too: the next save writes the new title in, changing only that value's characters. Anyone who can't open the page sees the reference as written, the same as for a page or key that doesn't exist. Both editors complete the page after `` `=[[ `` and its keys after the dot. A public link's copy writes in values from those pages' published versions only, and the public link dialog and the Publish confirmation say the page shows them. (#190)
- Inline code `=servings` in a page's body, or Dataview's `= this.servings`, shows the page's `servings` value, with a dotted underline and a hint naming the property: a list comma-separated, a date in your locale, a page link as a link. A name the page has no property for shows as written. The visual editor shows the value beside the code, and typing `` `= `` completes the page's keys in both editors. **Add property** suggests the keys that pages in the same folder use. A public link's copy has the values written in as plain text, its frontmatter still left out. (#188)
- Open search follows pages others change, and those changed on your other devices, without being closed and opened again. A save while the index rebuilds now waits for it, rather than starting it over. (#184)
- A page's properties show as rows between its status pills and its body, each key in sentence case and each value as what it reads as: a list as pills, a number, a checkbox, a date in your locale, a web address, a page link or text. Readers see six, then **Show N more**. On the draft, a value is edited in place, and each row's menu renames it, changes its type, removes it or puts a reference to it in the page; **Add property** adds one. Only the edited characters of the frontmatter change, so its comments, quoting and order stay as written. A value that can't be changed that way, or a block that doesn't read as properties, opens as text. (#185)

#### Desktop

- A link's hint, saying where it goes, shows above the link instead of below it, where the pointer covered it. Near the top of the window it still shows below. (#179)

#### Server

- Nodemailer 10.1.4, from 10.0.13, for outgoing mail. It fixes three published advisories in how it reads addresses, where a crafted address could add a recipient or send to a domain the header doesn't name. (#183)

#### CLI

- `wikistow search` takes the same filters as the app's search, `tag:soup` and `key:value`, and so do agents' and plugins' searches. (#187)
- `wikistow folder create --name NAME [--space SPACE_ID] [--parent FOLDER_ID]` makes a folder where the agent may edit, at the top of its share unless `--parent` names one, so an agent can rebuild a set of notes' folders before creating their pages. It takes `--idempotency-key` like the other changes, and the skill says to use it when moving notes in. (#171)

#### Development

- ADR 0006 (`docs/adr/0006-page-properties.md`) records page properties: how frontmatter is read and changed one value at a time, references to values in the page, tag and property search, query tables and the folder view. It amends ADR 0005, decision 1: a public link’s copy now holds the values its body shows. The spec, the protocol’s A12, `ui-design.md` and the glossary change with it. (#178)
- The client reads a page's frontmatter as typed properties, with the `yaml` package, and edits one value, key or property's lines without rewriting the rest of the block. The property rows, references to values, and property search will build on it. (#181)
- The search index keeps each page's properties beside its text, and lists pages by space, folder and tag, with the keys they use, for query tables, the folder view and references to other pages' values. The desktop app reads every page once more after updating. (#184)

## 0.16.1 - 2026-10-23

### Highlights

#### Maintenance

- Dependencies with published security advisories are updated: DOMPurify, which the editor uses, and the Vite+ toolchain that builds and tests WikiStow.

### Changes

#### App

- DOMPurify 3.4.17, from 3.4.16, in the editor. (#169)

#### Development

- Vite+ 1.3.0 and Vitest 5.0.5, from 1.0.0 and 5.0.1, with `@vitest/browser-playwright` to match. The Vite that Tailwind, TanStack Router and the React plugin load as a peer is 8.3.4, from 8.3.2, through a `vite@8` override, and a `playwright` override keeps Playwright on 1.63.0, the version in the browser tests' image. The rest of the lockfile is refreshed within its ranges. (#169)

## 0.16.0 - 2026-10-23

### Highlights

#### Features

- You can delete a space you own, from its menu. The app says who loses access and asks you to type the space’s name first. Your home space stays.
- You can share a published page with anyone through a public link, even people without an account. Right-click the page and choose **Share public link…**.

### Changes

#### App

- **Delete space…** in a space's menu deletes it for everyone, with every page, folder, attachment and version in it. It names the co-owners, people and groups who lose access, offers leaving or a transfer instead, and asks for the space's name. It isn't offered for your home space. Anyone viewing a space that's gone, or no longer shared with them, goes to their home space. (#158)
- **Share public link…**, in a page's right-click and ⋯ menus for people who can publish it, gives a published page a link anyone can open. Before the first link, the dialog says anyone with it can read the page and the server keeps a readable copy until the link is turned off. With a link on it has **Copy link** and **Turn off the link**, and **Update public page** when the public page is out of date. **Publish** on a page with a link asks first, then updates the public page. A globe marks pages with a link in the sidebar and on the page. (#164)

#### Server

- Streams (`POST /api/ai/stream` and `GET /api/me/tree-changes`) send the renewed session cookie when they're the request that renews a session. (#155)
- `POST /api/spaces/:spaceId/delete {permissionVersion}` deletes a space and everything in it, for its owners. It refuses a space that is any owner's home space (`home-space`), and a delete sent before access last changed (`permission-version`), so the owner was shown everyone who loses access. It ends the space's publications into other spaces as deleting a page does, removes its attachment files, and drops it from everyone's saved space order. The audit log records `space.deleted` with counts only. (#158)
- Public links (ADR 0005). `POST` and `DELETE /api/pages/:pageId/public-link` turn a page's link on and off, and `GET /api/spaces/:spaceId/public-links` lists a space's links. A copy of the published version is staged (`POST /api/pages/:pageId/public-copies`), gets its files (`PUT /api/public-copies/:copyId/files/:attachmentId`) and goes live (`POST /api/public-copies/:copyId/live`). People only, never agents. The server renders it in a worker with the app's reader rules and serves it at `/p/<id>` with no script, its own policy and `noindex`. Turning the link off, unpublishing, deleting the page, a folder above it or its space, and publishing again delete the copy in the same transaction. `backup.sh` leaves the copies out. (#161)
- A public link ends, with every copy of its page, in the same request that takes its sharer's publish rights away: a move, a removal from the share, a group or the owners, losing publish rights, or suspension. A copy goes the same way when its uploader loses the rights, and someone else's link stays on. (#163)
- `GET /api/me/tree-changes` now tells someone given access to a space and shut out again within a few seconds, so their app drops the space at once. Before, it kept the space until the window was next focused. (#166)
- Ending lapsed public links checks each person's publish rights once, not once per page, so saves in a space with many public links no longer wait as long behind a change of access. Adding someone to a group and giving waiting access skip the check, since they only give rights. (#167)

#### Development

- ADR 0005 (`docs/adr/0005-public-links.md`) records how public links for pages work, and the spec's plaintext rule now allows their one exception: the published version of a page with a public link, stored readable only while the link is on. The protocol gains accepted risk A12. (#159)
- The reader's Markdown rules (alerts, heading ids, highlighting, wikilinks and `pageHtml`'s sanitizing) move from `packages/ui` to `@wikistow/client/reader`, so the server can use them too. The app reads pages as before. (#160)
- Q12 in the protocol's open questions records that a deleted space's ID can be used for a new space, and what former members' apps then accept there. (#165)
- `AGENTS.md` tells coding agents how to see a release through: wait for CI on the merged version change, then check it before tagging. (#152)

#### Releases and packaging

- Electron 44.9.3, from 44.9.2. (#168)

## 0.15.0 - 2026-10-20

### Highlights

#### Features

- Pages can start from a template. Put a page in a folder named Templates, then pick **New page from template…** beside New page. It asks for each `{{variable}}` in it and fills in the title, your name, the date and the time.
- The sidebar keeps up on its own. Pages and folders an agent makes, moves, renames or deletes show up within a second or two with no refresh, as do changes from your other devices and from people you share a space with.

### Changes

#### App

- Pages can start from templates: any page in a folder named Templates. **New page from template…** (beside New page, and in a folder's menu) asks for each `{{variable}}` in it, fills in `{{title}}`, `{{me}}`, `{{date}}` and `{{time}}`, and copies its properties, cover, attachments and links. (#147)
- The sidebar shows pages and folders as they change elsewhere, within a second or two and with no refresh: what an agent makes, moves, renames or deletes, edits from your other devices, and changes by people you share a space with. The page you’re on stays put. (#150)

#### Server

- `GET /api/me/tree-changes` streams to a signed-in person, as JSON lines, the spaces they see whose tree changed, never what changed. A database trigger names each space, and the server keeps one more database connection open to hear it, named `wikistow-tree-changes`. (#150)

#### Releases and packaging

- Electron 44.9.2, from 44.9.0. (#151)

## 0.14.0 - 2026-10-19

### Highlights

#### Features

- Moving a page or folder can skip its confirmation step. Tick **Don’t ask again** on it, and from then on a drop in the sidebar moves at once and Move… moves as soon as you pick a place. The choice is kept per browser or computer; **Ask before moving** in Settings → Pages turns the step back on.

#### Fixes

- Chrome, Edge and other Chromium browsers on a Mac use Cmd+K for search, as Safari and Firefox already did.
- A link with a title no longer shows the browser’s own tooltip in the visual editor. The title stays in the page and in what you copy.
- On Windows, the command-line client’s messages show paths with single backslashes, not doubled ones.

#### UI polish

- The web app has its own icon in browser tabs and on iPhone and iPad home screens.
- The Agents page’s description takes the page’s width, with its buttons in a row below.

### Changes

#### App

- The web app has a favicon, the desktop app's icon as an SVG, and a 180 px `apple-touch-icon.png` for iPhone and iPad home screens. (#137)
- Chrome, Edge and other Chromium browsers on a Mac use Cmd+K for search, and the visual editor's toolbar names Cmd shortcuts there, as Safari and Firefox already did. (#140)
- The Agents page's description takes the page's width, with its buttons in a row below. (#140)
- A link with a title no longer shows the browser’s own tooltip in the visual editor, beside the desktop app’s hint. The title stays in the page and in what you copy. (#142)
- Moving a page or folder can skip its confirmation: **Don’t ask again** on that step turns it off on this browser or computer, and Settings → Pages → Ask before moving turns it back on. A drop in the sidebar then moves at once, and Move… moves once a place is picked. (#143)

#### CLI

- Messages print paths as they are, so on Windows they show `C:\Users\me\AppData\Roaming\wikistow`, not every backslash doubled. Paths and other text the user gave the CLI are no longer escaped; server text, decrypted content and system errors still are, and `--json` is unchanged. (#141)

## 0.13.0 - 2026-10-19

### Highlights

#### Features

- The browser can remember your vault unlock, so new tabs and later visits open without the passphrase. It’s off until you turn on **Remember on this browser** on the unlock page or **Remember unlock** in Settings → Security; locking, signing out or changing your passphrase forgets it.
- Code blocks have a copy button that copies the code as written, without its language label.
- The command-line client is one file for Linux, macOS and Windows, with nothing else to install. Install or update it with `curl -fsSL https://github.com/skint007/wikistow/releases/latest/download/install.sh | sh`, or on Windows with `install.ps1`.
- In the desktop app, hovering a link shows where it goes: its address, or the page’s name for a link to another page.
- On a Mac or Windows PC, an AI tool can run the command-line client without a passphrase: `wikistow agent enroll --secret-store` keeps its unlock in the Keychain or in Credential Manager, as it does in the desktop keyring on Linux.
- The Agents page has a setup guide for command-line agents: install the CLI, enroll it and hand it to your AI tool, in three steps for Linux, macOS and Windows, with this server’s address in the enroll command.

#### UI polish

- Hover hints match your theme in light, dark and plugin themes, and so do checkboxes, radio buttons and sliders.
- Password managers are asked to leave fields that aren’t sign-in details alone, such as folder and space names, search and page titles. Bitwarden only does so once you turn on its “Allow websites to exclude fields to autofill” setting.

#### Upgrade notes

- If you run the CLI from the release’s `wikistow-cli` archive, it no longer has the `wikistow` launcher: install the binary with the install script, or run `node wikistow.mjs`. `wikistow-cli-bin` on the AUR updates by itself and no longer needs `nodejs`.

### Changes

#### App

- Code blocks in the reader have a copy button at the end of their language line. It copies the code as written, without the label, and shows a check for a moment. Blocks a plugin draws and the visual editor’s code blocks have none. (#123)
- The browser can remember the vault unlock, off by default: **Remember on this browser** on the unlock page, or **Remember unlock** in Settings → Security. Later visits and new tabs then open the vault without the passphrase, from a copy of the vault key sealed in `localStorage` (`wikistow.vault`) under the tab unlock's wrapping key. Locking, signing out or a passphrase change made anywhere forgets it. (#124)
- Fields that aren’t credentials, such as folder and space names, renames, search, page titles and the people picker, tell browsers and password managers to leave them alone: `autocomplete="off"` plus the 1Password, LastPass, Bitwarden and Dashlane ignore hints. `Input` adds them unless the field is a password or has a real `autocomplete`, so sign-in, account, passphrase and two-factor fields are unchanged. The admin SMTP password and AI API key get the hints too. Bitwarden reads its hint only when its user turns on “Allow websites to exclude fields to autofill”. (#125)
- Hover hints are themed tooltips in the popover colours, in place of the browser's own `title` tooltips. Any element gets one with a `data-hint` attribute, shown by one `HintLayer` at the app root; the visual editor toolbar's dark tooltips use it too. Checkboxes, radio buttons and sliders (the publish dialog's attachments, the invitation role, the banner's focal point, task lists) are drawn in the theme's colours. (#131)
- In the desktop app, which has no status bar, a link's hint says where it goes: the address of a link in the reader or the visual editor, or of What’s new's release link and the update link, cut short past 200 characters and wrapping after a slash; a wikilink in the reader gives the page's name (and heading). Footnotes and other `#` links in the page, and attachments, get none. A browser shows its own status bar, so it gets no hint. (#133)
- The Agents page links to the new setup guide (`/agents/guide`) from its header, its empty state, which no longer shows the enroll command, and the Add an agent dialog. The guide opens on the browser’s own system. Its steps are Markdown shipped with the app, shown through the page reader. (#128)

#### CLI

- The CLI runs natively on Windows. It keeps its files in `%APPDATA%\wikistow`, where the user profile's permissions keep other users out, so it checks no Unix owners or modes there. On Windows, `--passphrase-fd` takes only `0` (standard input), and messages print as UTF-8. (#130)
- `--secret-store` and `wikistow agent secret-store enable` work on macOS and Windows too, so an AI tool can run the CLI there without a passphrase. macOS keeps the unlock secret in the login Keychain through `/usr/bin/security`; Windows keeps it in Credential Manager, under Web Credentials (`wikistow`), through Windows PowerShell. Over SSH a Mac's login keychain is locked, so the CLI says to run it from the desktop or unlock it with `security unlock-keychain`. `agent status` names the store, in `secretStore.store` with `--json`. `--secret-tool` is only for Linux. (#134)
- `wikistow agent enroll` exits once it's done. On every system, it used to keep running after a successful enroll until Ctrl+C. `--passphrase-fd 0` is refused with `--file -` or `agent enroll`, which read standard input too. (#130)

#### Releases and packaging

- Each release has the CLI as one binary per system, built by Bun 1.4.3 from the tested bundle: `wikistow-linux-x64`, `wikistow-linux-arm64`, `wikistow-darwin-arm64`, `wikistow-darwin-x64` and `wikistow-windows-x64.exe`, beside `install.sh`, `install.ps1` and `LICENSE`, all in `SHA256SUMS`. The release checks the Linux x64 binary. `wikistow-cli-<version>.tar.gz` stays, for Node.js, without its `wikistow` launcher. (#126)
- `wikistow-cli-bin` on the AUR installs the binary, for x86_64 and aarch64, and no longer needs `nodejs`. (#126)

## 0.12.0 - 2026-10-18

### Highlights

#### Features

- Folders, spaces and pages can show an icon. The picker’s new Icons tab searches every Lucide icon by name, drawn in the text colour.
- Avatars can be up to 2.5 MB, up from 2 MB.
- `wikistow skill` prints a skill you can save for an agent, so it knows how to use the CLI: it leaves changes as drafts unless you ask, and puts new pages in your Personal space.

#### UI polish

- On this page marks the section you’re reading with a tint only, without the bar at its left.
- Rename… is gone from the person menus in the Share dialog, Members and owners and a group’s members. A contact keeps the name they had when you first shared with them.

### Changes

#### App

- On this page marks the section being read with the tint only, without the bar at its left. (#107)
- Avatars can be up to 2.5 MiB, up from 2 MiB. Migration 0033 re-adds the `avatars_size` check at the new size. (#108)
- **Rename…** for contacts is gone from the person menus in the Share dialog, Members and owners and a group's members, with `RenameContact` and `sharingOperations.renameContact`. A contact keeps the name saved when they were pinned. The `relabel` contacts change stays last-write-wins. (#110)
- The emoji picker has an **Icons** tab for folders, spaces and pages: any Lucide icon, found by name and drawn in the text colour. Folders and spaces store it as `wikistow.symbol` in their metadata, pages as `symbol` in `wikistow.cover`, with the emoji kept beside it for older apps and the CLI. The icon set loads as one chunk the first time it’s needed. (#112)

#### CLI

- `wikistow skill` prints a skill that teaches an agent to use the CLI: it leaves changes as drafts unless its person asks for them published, and puts new pages in the person’s Personal space. (#109)

## 0.11.0 - 2026-10-18

### Highlights

#### Upgrade notes

- No two people on a server can share a name now. The upgrade renames later accounts that share one to “Name (2)”, “Name (3)”, oldest first.
- The `bootstrap-admin` command is gone. A new server asks for its administrator the first time you open it. A server upgraded partway through the old setup, with an account but no administrator, needs to start again on an empty database.
- Everyone with a vault can now see the name and email of everyone else on the server, to pick them when sharing. This is a deliberate choice for servers where people know each other.
- Administration → Registration is now Administration → Settings. Plugins moved from Settings to Settings → Plugins.

#### Features

- A new server asks for its administrator the first time you open it. That account signs in straight away, before mail is set up.
- When you share, add a group member or add an owner, you can pick the person from a list of people on the server, filtered by name or email, instead of typing their whole email.
- Drag your spaces into the order you want in the rail, or use Move up and Move down in a space’s right-click menu. Your home space stays first, and the order follows you to every device.
- Administrators can set up mail in Administration → Settings, and send a test email before saving. The server now starts without mail, and `SMTP_URL` and `SMTP_FROM` are optional; when set, they still win.
- Administrators can connect an AI provider in Administration → Settings and pick the model from the provider’s own list, searchable even when it has hundreds. Each `AI_*` variable is now optional and still wins when set.
- You can change your name in Settings → Account. No two people on a server can have the same name, ignoring case and spacing.
- Owners can rename a contact with Rename… in the person’s menu in the Share dialog, Members and owners, and a group’s members. When that person changed their name on the server, the new one shows beside the field.

#### UI polish

- Settings is grouped into Account, Security, Appearance, Plugins and AI assistant, with a list to jump between them. Forms such as Email, Password and Two-factor sign-in open when you choose Change or Manage, and Desktop apps opens with Review.
- Settings → Plugins has Installed and Library tabs and a search. A plugin’s own settings open from its row there.

### Changes

#### App

- People can reorder their spaces in the rail: drag any tile but the home space, or use Move up and Move down in a tile’s right-click menu. The order is kept with the account (`space_order` on `users`, `GET`/`PUT /api/me/space-order`) and `GET /api/spaces` comes back in it, home space first, in its released shape. Phones show the order in the drawer. (#97)
- Administration’s Registration tab is now **Settings**, with a **Mail** card: server, port, security, username, a write-only password, From, **Save** and **Send test email**, which says why a test failed. (#99)
- Administration → Settings has an **AI assistant** card: API style, base URL, a write-only key, the model, the longest reply and requests a minute per person, with **Save** and **Check connection**. The model field lists the provider’s models when clicked into, searchable by ID and name with a count, drawing the first 100 matches, with arrow keys, Enter and Escape and **Refresh**; any name can still be typed (`components/ui/combobox.tsx`). People’s AI failure messages no longer name environment variables. (#100)
- The first share, **Add someone**, **Add member** and adding or handing over an owner list the people on the server to pick from, filtered by name or email. Pinned people show by their label with **Key changed**, others by the server’s name and email marked new. People who can’t be chosen, and accounts without a vault yet, are greyed out with the reason. Picking a row runs the same key checks as typing that email, which still works. (#98)
- Settings → Account has a **Name** row first, with **Change name**. Person menus in the Share dialog's access list (owners too), Members and owners, and a group's members have **Rename…**, which changes the contact's label name, keeping its email, and shows the server's name in quotes as a hint when it differs, never filled in. An empty name on the setup and invite forms says "Enter your name". A label rename now applies last-write-wins, as protocol section 8.6 says. (#103)
- Settings is one page of five groups (Account, Security, Appearance, Plugins, AI assistant) of compact rows, each with its state and one action, and an "On this page" list that follows the scroll. Email, Password and Two-factor sign-in open their forms on demand, Desktop apps opens **Review**, and settings kept on one device have a "This browser" or "This computer" pill. Plugins moved to a page of their own, `/settings/plugins`, with Installed and Library tabs and a search; a plugin's own settings sections open from its row there. (#101)

#### Server

- The first account on a new server becomes its administrator. While the server has no accounts, sign-in and `/` open **Set up WikiStow**, `GET /api/installation` reports `setup: true`, and `POST /api/setup` creates the account under the admin lock, with its address counted as verified. It refuses once any account exists. The `bootstrap-admin` command, `admin.mjs` and the `bootstrap` invitation kind are gone, and open bootstrap links are withdrawn. A server upgraded before its `bootstrap-admin` setup finished has an account but no administrator, so start it again on an empty database. (#96)
- `GET /api/people` lists everyone the exact-email lookup could find, for people with a vault and rate-limited like it, and by name and email the confirmed accounts without a vault yet. Every person with a vault can now see who else is on the server, a deliberate choice recorded in protocol section 7.3. (#98)
- Mail can be set on the admin page as well as by `SMTP_URL` and `SMTP_FROM`, which are now optional and win over it. The settings live on the `settings` row, with the password sealed under a key derived from `BETTER_AUTH_SECRET`, so it reads as unset under another secret. `GET`/`PUT /api/admin/settings/mail` and `POST /api/admin/settings/mail/test` are new, and saves apply without a restart. With no mail set up, everything that would send mail answers `mail-off`. (#99)
- Account names are unique, case ignored, and stored trimmed with inner whitespace collapsed (`users_name_unique` on `lower(name)`; accounts not finished yet keep the empty name and are left out). Invitations, setup links, first-run setup and the new `PUT /api/me/name` answer `name-taken` (409) for a name in use. The migration first gives later accounts that already share a name a " (2)", " (3)" suffix, oldest first. (#103)
- The AI provider can be set on the admin page as well as by the `AI_*` variables, each now optional and winning over its field; a partial environment no longer stops the server. The AI routes read the provider and its rate limit on each request, so a save applies without a restart, and `GET /api/ai` keeps its shape. The key is sealed like the SMTP password. `GET`/`PUT /api/admin/settings/ai`, `POST /api/admin/ai/models` (OpenAI and Anthropic lists, paged, up to 2,000 in 10 seconds, with the saved key when none is typed) and `POST /api/admin/ai/check` are new. (#100)

## 0.10.0 - 2026-10-18

### Highlights

#### Features

- You can rename a folder with Rename… in its menu. Its emoji, colour, image and contents stay as they are.
- Owners can change a space’s name, emoji and image with Name and look… in the space menu. The rail and the sidebar show the image, else the emoji, else the initials.
- Right-click a folder or page in the sidebar, or press the menu key or Shift+F10 on it, to open its menu. Folders show their ⋯ items, and pages show Open and what you can do with them.

#### UI polish

- New space takes names up to 200 characters, like folders.
- Publish to another space… now says “Copies the draft as it is now” or “Copies this published version”.

### Changes

#### App

- **Rename…** in a folder’s menu, for editors, changes only its name through `spaceOperations.updateMetadata`, so its emoji, colour and image stay. (#85)
- **Name and look…** in the space menu, for owners, changes a space’s name and its emoji or image, kept as `wikistow.icon` as for folders. The rail and the sidebar header show the image, else the emoji, else the initials. (#86)
- Right-clicking a folder or page in the sidebar, or the menu key or Shift+F10 on a focused row, opens its menu at the pointer: a folder’s ⋯ items, built from the same list, and for a page Open plus what its Page actions menu offers that person, loaded as the menu opens. The desktop app shows it in place of the native menu on these rows only. The delete page dialog moved to `page/delete-dialog.tsx`, and Publish to another space… now says “Copies the draft as it is now” or “Copies this published version”. (#87)

## 0.9.0 - 2026-10-17

### Highlights

#### Upgrade notes

- The desktop app has no menu bar now. Its items are in the ⋯ Window menu at the top right, and their keys still work.
- On generic invitations, New link is now Copy link.

#### Features

- You can change your email address in Settings → Email. A link goes to the new address, and nothing changes until you open it. People you share with keep seeing your old address in their contacts, and your authenticator app keeps its old name. Both keep working.
- Copy link on a pending invitation, email ones too, makes a new link and copies it without sending an email. The link sent or copied earlier stops working, and it asks first.
- The sidebar remembers which folders you opened, on each device, through reloads and restarts.
- On this page marks the section you’re reading as you scroll.
- The desktop app opens at the size and place you left it, and maximized if it was.
- The desktop window has WikiStow’s own titlebar instead of the system’s title bar and menu bar. App plugins can add a button to it.

### Changes

#### App

- Pending invitations each have Copy link, email invitations too. It asks first, then makes a new link, copies it and sends no email. The link sent or copied earlier stops working. If the clipboard refuses, the link stays shown to copy by hand. Generic invitations' New link is folded into it. (#75)
- Settings has an Email section for changing the account’s address. It asks you to confirm it’s you, then mails a link to the new address. Nothing changes until that link is opened (`/confirm-email`), and then the old address gets a notice. (#76)
- The sidebar remembers which folders are open, on the device, per server, account and space, through reloads, space changes and app restarts. Filtering still opens every folder with a match until the filter is cleared. (#78)
- On this page marks the section you’re reading, as you scroll and after following a link to a heading, with a bar at its left and `aria-current`. Beside the page, a long list scrolls to keep the mark in view. (#79)

#### Desktop

- The desktop app opens its window at the size and place it was last left, fitted to the screen, and maximized if it was. They're kept in `window.json` in the app's `userData`, for the device rather than an account. (#77)
- The desktop window has WikiStow’s own titlebar in place of the system title bar and the menu bar. Drag it to move the window and double-click it to maximize. **Window menu** (⋯) has Reload, the zoom items, Full screen and Developer tools, whose keys still work, and Ctrl+W closes. Reloading with changes not saved yet now asks first, and if the window’s page stops, the app asks whether to reload or close. (#80)
- App plugins can add a small button to the desktop titlebar with the `app.titlebar` region. The reading room example has one. (#80)

#### Server

- `POST /api/admin/invitations/:id/link` replaces an invitation's token and expiry and returns the link without mailing it. The `invitation.resent` audit event now records `mailed`. (#75)

#### Releases and packaging

- Electron 44.9.0, from 44.8.0. (#81)

## 0.8.0 - 2026-10-16

### Highlights

#### Upgrade notes

- Apps from before this release see only Shared plugins in the library, and keep the plugins they already installed. Update the app on each device to see your Only me plugins and to use plugin drafts.
- The workshop’s Install and Share to library… are gone. Use Publish… instead, which installs the plugin on all your devices.

#### Features

- The plugin workshop now works in the browser and on phones as well as the desktop app. Plugin drafts are saved on your server as the assistant writes them, so you can carry on from another device. You can keep 10, and the workshop asks before a new one deletes the oldest. The first build on each device downloads a 14 MB build tool, kept for later builds.
- Publish… in the workshop puts the version you’re previewing in the library, Shared or Only me, and installs it on all your devices.
- A library plugin can be Shared or Only me. Only me hides it from everyone else, but people who already installed it keep it and its updates.
- Change with the assistant, on a library plugin in Settings → Plugins, opens the workshop on its source. Someone else’s plugin becomes a copy under a new ID of your own.
- Upload project folder…, on the workshop page on a computer, turns a plugin project built with the SDK into a draft.
- Uploading a plugin now installs it for you on all your devices. Upload plugin folder… asks once before it uploads, instead of uploading as soon as you pick the folder.

### Changes

#### App

- A library plugin is Shared or Only me, chosen by its owner when they upload it or from its row in Settings → Plugins. Only me hides it from other people's listing, except for anyone who already installed it, who keeps it and its updates. Each listing sends the hashes the person approved (`have`); the desktop app's own listing does too. (#65)
- The plugin workshop works on plugin drafts saved on your server, so you can carry on from another device, and opens in a computer's browser as well as the desktop app. Its page lists your drafts, with Open, Delete and New plugin, and asks before a new one deletes the oldest of 10. Plugins build in the page, so the first build on a device downloads esbuild's WebAssembly (14 MB), cached after. The workshop's Install and Share to library go, replaced by Publish (#67). (#66)
- The plugin workshop works on phones too: one column, with the conversation in a sheet whose Open the preview closes it. Publish… uploads the version in the preview to the library, Shared or Only me, and installs it for you on all your devices, from any device. The draft stays, for the next version. (#67)
- Change with the assistant, on a library plugin in Settings → Plugins, makes a plugin draft of its newest version's source and opens the workshop on it. Someone else's plugin becomes a copy under a new ID of your own, and the workshop says so. Upload project folder…, on the workshop page on a computer, makes a draft from a project built with the SDK. Settings → Plugins in the browser now links to the workshop. (#67)
- Uploading a plugin installs it for you on all your devices. Every way of uploading (Upload plugin folder…, and Share to library… on the desktop) asks once first, showing what the approval dialog shows, with Shared or Only me. Settings' folder upload used to upload as soon as the folder was chosen. (#65)

#### Desktop

- The desktop's main process no longer keeps workshop workspaces or builds plugins: it serves the builds the page hands it for the preview and exports one to a folder, `<id>-<first 8 of its hash>`. `esbuild-wasm` moves to the web build. (#66)

#### Server

- Plugin drafts on the server (ADR 0004): `pluginDraftRoutes` list, make, read, change, delete and build a person's drafts, people only. A draft starts empty, from files, or from a library version's `source/`, and a version of someone else's plugin gets a new ID (`<id>-copy`, `-copy-2` and on). At most 10 per account, and within the workshop's limits, which move into `packages/contracts`. The library's file route serves a draft's build to its owner under `/plugins/<id>/draft-<hash>/`. Drafts live in Postgres, so backups take them with no script change (migration `0026_plugin_drafts`). They don't count against storage quotas: at most about 140 MB per account. The library upload's checks are now `checkUpload`, which draft builds share. (#64)
- `plugins.visibility` (migration 0027), `PUT /api/plugins/:pluginId/visibility` for the owner, `GET /api/plugins/private` for the owner's Only me IDs, `visibility` on uploads, and `have` on `GET /api/plugins`. The listing's response doesn't change, so older apps keep working and see Shared plugins only. (#65)

#### Development

- ADR 0004 (`docs/adr/0004-plugin-drafts.md`) records private plugins, plugin drafts on the server and the plugin workshop in the browser and on phones, amending ADR 0002. (#63)

## 0.7.0 - 2026-10-16

### Highlights

#### Upgrade notes

- Apps from before this release show a folder’s or page’s emoji instead of its image, and list a page’s image among its attachments. Update the app on each device to see and change images.

#### Features

- A folder can show your own picture, logo or drawing instead of an emoji. In New folder or Emoji and colour…, open the emoji tile and choose Image. It’s resized and encrypted on your device.
- A page can show an image instead of an emoji too. While editing, click the emoji badge (or Add emoji) and choose Image. It shows on the page and in the sidebar, and readers see it once you publish.

### Changes

#### App

- Folder images: the emoji picker (`EmojiPopover`) has an Image tab when given `image`. A folder's image is stored in its encrypted metadata as the `wikistow.icon` extension (`folderIconOf`, `folderIconChange`), resized in the browser to fit 144 px and at most 16 KB as WebP, or PNG or JPEG where the browser can't write WebP (`iconImage`). SVG is drawn as pixels and never stored. `createFolder` takes an optional `icon`. The sidebar shows the image through `IconImage`, which falls back to the emoji. No server change. ADR 0003. (#59)
- Page images: `wikistow.cover` gains `icon: {attachmentId}`, one of the page's attachments resized like a folder image (`coverOf`, `reviseCover`). The cover editor uploads it from the picker's Image tab (`uploadIcon`), the badge and the sidebar's page rows show it, and the draft's attachment list leaves it out. `PageLabel` carries the icon's attachment and audience (`pageIconOf`). A copy into another space without the icon's attachment leaves the icon out (`coverLeftBehind`, replacing `bannerLeftBehind`). Decrypted attachment URLs are now kept until the vault locks rather than decrypted again after five minutes. No server change. ADR 0003 is built. (#61)

#### Development

- ADR 0003 (`docs/adr/0003-image-icons.md`) records where folder and page images live, their limits and the fallback. (#57)

## 0.6.0 - 2026-10-16

### Highlights

#### Features

- Folders can have their own emoji and colour. Choose them in New folder, or later with Emoji and colour… in the folder’s menu.
- In the desktop app, right-clicking a misspelt word offers suggestions and Add to dictionary. Right-clicking in a text field offers Cut, Copy, Paste and Select All, and on selected text, Copy.
- What’s new, in the account menu, lists every release with its highlights.
- Each release has the command-line client, `wikistow`, as an archive that runs on Node.js 26 or newer. On Arch, install it from the AUR as `wikistow-cli-bin`.

#### Fixes

- When a draft can’t be saved because the app refused something the server sent, such as an older folder key, the editor now says why. It no longer offers Try again when trying again can’t help.

### Changes

#### App

- The draft editor names the reason for a refused save that the app knows, after "Your last changes could not be saved.", and leaves out Try again for crypto stops a retry can't clear, such as `key-version`. The crypto stop messages that fit any write moved from `sharing/messages.ts` to `stopMessage` in `errors.ts`. The share dialog's wording is unchanged. (#51)
- Folder emoji and colour: New folder has the fields, and the folder menu's **Emoji and colour…** changes them through `spaceOperations.updateMetadata`. `createFolder` takes an optional look; the default is still ⭐ on blue. The page cover's emoji picker became `EmojiPopover`, which takes any trigger. (#55)
- **What's new** in the account menu opens `/whats-new`, the release highlights from this file, newest first. (#58)

#### Desktop

- The app window has a context menu: spelling suggestions (`replaceMisspelling`), **Add to dictionary**, and Cut, Copy, Paste and Select All from the click's edit flags. Only the top frame gets it, not plugin frames. Spellcheck keeps the system locale. (#54)

#### Releases and packaging

- Each release has `wikistow-cli-<version>.tar.gz`, with `wikistow.mjs`, a `wikistow` launcher and the licence, listed in `SHA256SUMS`. The release checks it runs outside the workspace before publishing. (#53)
- New AUR package `wikistow-cli-bin`, published beside `wikistow-desktop-bin` for each stable release. A hand-run of the AUR workflow takes a `package` input: `both`, `wikistow-desktop-bin` or `wikistow-cli-bin`. (#53)
- The release job that publishes the GitHub Release is now `github-release`. It was `desktop`. (#53)
- GitHub Release notes come from this file (`node scripts/changelog.ts notes <tag>`), not from a list of pull requests. CI's `check` job checks every entry and that the newest is the version in `package.json`. The release's `verify` job also checks every tag has a dated entry, and publishing fails without one. (#58)

## 0.5.0 - 2026-10-16

### Highlights

#### Upgrade notes

- Update WikiStow on every device. Apps from 0.4.0 can’t add a co-owner in a space that has groups, and a 0.4.0 desktop app can wrongly say at unlock that an agent didn’t get the newest keys.
- If you build plugins, build them again with the 0.5.0 plugin SDK. Scripts built with an older one read an empty plugin ID.

#### Features

- Groups: owners can make groups of people in a space, then share folders with a group. Each person gets the higher of their own access and their groups’. Owners find Groups in the space menu, and in Members and owners.
- Owners can add agents to groups too. The agent’s person confirms it on the Agents page, under Through groups.
- After someone’s key changes, Share again is now Give access. It also covers the folders they reach through groups.
- Plugins now run in the browser and on phones too, from the server’s plugin library. Upload a built plugin folder in Settings → Plugins in the browser, or use Share to library… in the desktop app. Install plugins from the library on any device. The ones you approve follow your account.
- If the server is restored from an older backup, the app tells you once, with the date of the backup. The command-line client says so too, and carries on instead of refusing the server.
- With the system keyring, the desktop app keeps its search index between launches, encrypted, and only reads the pages that changed since.

#### Fixes

- With the system keyring, the desktop app remembers the newest keys and contacts it has seen between launches, so a server offering older ones is still noticed after a restart.

### Changes

#### Groups

- Design: Milestone 5 in `wikistow.md`. (#29)
- Server and protocol: `groups`, `group_members` and `share_groups` (migration `0024_groups`), effective access as the higher of a direct grant and group access, owner-only group routes, the waiting list and **Give access**, and protocol sections 7.8 and 7.9. Group names are owner-only encrypted records. `listShares` is unchanged for released apps. (#39)
- Client operations: `groupOperations`, with every change planned as a `GroupChange` for the owner to confirm, and `shareAccess` for each person's access and where it comes from. (#40)
- Interface: the Groups page and a group's page, and groups in the share dialog. **Waiting for you** also lists people waiting for keys, with **Give access**, which replaces **Share again** after a key change. (#44)
- Agents in groups: an owner adds an agent (`POST /api/groups/:groupId/agents`), and its person sees it (`GET /api/me/agents/groups`) and confirms or leaves on the Agents page. `agentGrantsOf` is the one read of an agent's access. Migration `0025`. (#45)

#### Plugins

- Design: ADR 0002, a plugin library on the server and plugins in the browser. (#32)
- The server's plugin library: upload, list and remove routes, files served from `/plugins/<id>/<hash>/<path>`, and `plugins/` in backups (migration `0023_plugin_library`). An ID stays with its first uploader. (#38)
- Approvals live in the account's private contacts record (`wikistow.plugins`), merged per plugin, with `pluginOperations`. (#36)
- Plugin scripts run in `data:` module workers inside a sandboxed frame, `plugin-host.html`. The app's CSP gains `frame-src 'self'`. Plugins built with an SDK from before this read `host.pluginId` as empty until rebuilt. (#37)
- Plugins in the browser: the library in Settings → Plugins, per-tab safe mode (`?safe-mode`, **Open without plugins**, or Ctrl+Shift+Alt+P), and plugins unloaded at lock. (#41)
- The desktop installs approved library plugins at unlock, checked against their hash, in `userData/library-plugins`, and offers **Share to library…** for folder installs and workshop versions. (#42)
- Desktop scripts run through the same frame, under `app://`. Folder installs refuse a script over 1 MB. (#43)

#### Restores

- `restore.sh` records `restored_at` and `backup_taken_at`, and `/api/installation` reports them (migration `0022`). The CLI starts its marks over after a restore and prints when the backup was taken. Browser and desktop show a "Restored from a backup" dialog once per restore. (#33)

#### Desktop

- An encrypted search index in `userData/search-index`, kept only with a trusted keyring and deleted at sign-out. A rebuild opens only pages whose version changed. (#31)
- The contacts mark and key version marks are kept in `userData/trust-marks`, sealed like the search index, so a rollback is still caught after a relaunch. (#35)
- Electron 44.8.0, from 44.7.2. (#46)

#### Development

- A note that Android edits in the source editor pass the CSP. (#30)

## 0.4.0 - 2026-10-15

### Highlights

#### Features

- The desktop app tells you when a newer release is out: a dot on your avatar, and Update available in the account menu, with how to update and a link to the release.

#### Fixes

- The server closes a connection that has sent and taken nothing for 60 seconds. While the AI provider is quiet, assistant replies send a keep-alive every 15 seconds, so a slow reply isn’t cut off.

### Changes

#### Desktop

- Update check: the main process asks GitHub for the latest release at start and every 6 hours, without a token, and keeps the answer in `update.json`. The new bridge call `update()` returns the newer release and how this copy was installed (`install-source`). The account menu shows it, and the top bar's menu button carries the dot in narrow windows. New palette token `update-dot`. (#26)

#### Server

- `server.setTimeout(60_000)`, and a blank line every 15 seconds in the AI stream while the provider is quiet. `docs/operations.md` has a section on idle connections: a reverse proxy's read timeout must be well over 15 seconds, which defaults such as nginx's 60 seconds are. (#27)

#### Development

- A weekly workflow, `electron-patch.yml`, opens an issue when Electron has a newer patch of the pinned major. (#24)
- The restore-lock test waits for terminated backends, which fixes a flaky failure. (#25)

## 0.3.0 - 2026-10-15

### Highlights

#### Features

- Upload a profile picture in Settings → Avatar. It shows in the account menu, the space header and the access lists. Avatars aren’t encrypted like your pages.
- The assistant chats show “Assistant is working…” from the moment you send until the reply finishes.
- The desktop app comes as a .deb for Debian 13 and Ubuntu 24.04 and 26.04, and an .rpm for Fedora 43 and 44, with each release.
- On Arch, the AUR package `wikistow-desktop-bin` installs the desktop app, and now follows each stable release.

#### UI polish

- Buttons look clickable, react to hover and press, show a ring for keyboard focus, and look different when disabled, in every palette.

### Changes

The same code as 0.3.0-rc.1, which tested the new package release path. These are the changes since 0.2.0.

#### App

- Profile avatars: a Settings card to upload, replace or remove one (JPEG, PNG, GIF or SVG, up to 2 MiB), shown through the shared `Avatar` component. (#18)
- A working indicator in the page chat and the plugin workshop, as a polite live status. (#15)
- Every button has a resting cue, hover and press tints, a 2px focus ring and a disabled look, in all four palettes. The dark palettes' `muted-foreground` is a little lighter for contrast. (#19)

#### Server

- Avatars: an `avatars` table (migration `0021`), `PUT` and `DELETE /api/me/avatar`, `GET /api/avatars/:id` without a session, and `GET /api/directory/avatars`. The type is read from the bytes, and SVGs are checked and served sandboxed. (#18)

#### Releases and packaging

- `wikistow-desktop-bin` on the AUR, which installs the release archive on Arch's `electron44`, and `.github/workflows/aur.yml`, which publishes it after each stable release. It replaces the old `aur/PKGBUILD`, which built from source. Its first version, 0.2.0, was published by hand. (#14)
- `.deb` and `.rpm` packages built with nfpm, which bundle Electron and are listed in `SHA256SUMS`. CI installs them on each supported distribution and checks every library resolves. `verify` fails unless Electron is its major's newest patch. Electron 44.7.2, from 44.6.0. (#20)
- Every package writes `/usr/lib/wikistow-desktop/install-source`, as `aur`, `deb` or `rpm`. The `wikistow-desktop` launcher runs the bundled Electron when there is one, and `electron44` otherwise. (#20)

## 0.3.0-rc.1 - 2026-10-15

### Highlights

#### Features

- Upload a profile picture in Settings → Avatar. It shows in the account menu, the space header and the access lists. Avatars aren’t encrypted like your pages.
- The assistant chats show “Assistant is working…” from the moment you send until the reply finishes.
- The desktop app comes as a .deb for Debian 13 and Ubuntu 24.04 and 26.04, and an .rpm for Fedora 43 and 44.

#### UI polish

- Buttons look clickable, react to hover and press, show a ring for keyboard focus, and look different when disabled, in every palette.

### Changes

A release candidate, to prove the `.deb` and `.rpm` release path before 0.3.0.

#### App

- Profile avatars: a Settings card to upload, replace or remove one (JPEG, PNG, GIF or SVG, up to 2 MiB), shown through the shared `Avatar` component. (#18)
- A working indicator in the page chat and the plugin workshop, as a polite live status. (#15)
- Every button has a resting cue, hover and press tints, a 2px focus ring and a disabled look, in all four palettes. The dark palettes' `muted-foreground` is a little lighter for contrast. (#19)

#### Server

- Avatars: an `avatars` table (migration `0021`), `PUT` and `DELETE /api/me/avatar`, `GET /api/avatars/:id` without a session, and `GET /api/directory/avatars`. The type is read from the bytes, and SVGs are checked and served sandboxed. (#18)

#### Releases and packaging

- `wikistow-desktop-bin` on the AUR, which installs the release archive on Arch's `electron44`, and `.github/workflows/aur.yml`, which publishes it after each stable release. It replaces the old `aur/PKGBUILD`, which built from source. A prerelease leaves the AUR alone. (#14)
- `.deb` and `.rpm` packages built with nfpm, which bundle Electron and are listed in `SHA256SUMS`. CI installs them on each supported distribution and checks every library resolves. `verify` fails unless Electron is its major's newest patch. Electron 44.7.2, from 44.6.0. (#20)
- Every package writes `/usr/lib/wikistow-desktop/install-source`, as `aur`, `deb` or `rpm`. The `wikistow-desktop` launcher runs the bundled Electron when there is one, and `electron44` otherwise. (#20)

## 0.2.0 - 2026-10-14

### Highlights

#### Features

- The first release from the public repository. WikiStow is a self-hosted encrypted wiki for people and their agents, with a browser app, a Linux desktop app and a command-line client.
- Pages are encrypted on your device before they reach the server. Write them in Markdown. Drafts save as you type, and readers see the versions you publish.
- Spaces hold folders and pages. Share a space or a folder with people as readers or editors.
- Edit in the source editor, the visual editor, or both side by side. Link pages with [[wikilinks]], search what you can read, and export a space to open in Obsidian.
- Give pages a banner and an emoji, and pick one of four palettes: Midnight slate, Warm charcoal, OLED black or Light.
- Agents read and write through the command-line client, each with its own keys and only where you let it.
- An optional AI assistant chats beside a page, through the provider the server’s operator sets up.
- The desktop app keeps its sign-in in the system keyring, and runs plugins, which you can build with the assistant in the plugin workshop.

### Changes

Everything before this release was built in a private repository. This release starts the public history, so its notes describe what it has rather than what changed. `README.md` and `wikistow.md` at this tag describe it in full.

#### Releases and packaging

- One version for every package, set with `node scripts/version.ts`, starting at 0.2.0. A release build shows `0.2.0` in the account menu, and any other build adds its commit, as `0.2.0+5b9e5ec4`. (#13)
- CI on GitHub Actions: checks, unit, integration and browser tests, the builds, a smoke test of the bundles, and web and desktop e2e. Pull requests get a read-only token and publish nothing. (#13)
- The server image on GHCR: `ghcr.io/skint007/wikistow:0.2.0`, `:0.2` and `:latest`. Each push to `main` publishes `sha-<commit>`. (#13)
- A GitHub Release for each `v*` tag, with `wikistow-desktop-<version>.tar.gz` and `SHA256SUMS`. (#13)
