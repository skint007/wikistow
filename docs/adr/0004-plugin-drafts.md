---
status: accepted
---

# Private plugins, plugin drafts on the server, and the workshop on every device

Plugins live in the server's library ([ADR 0002](0002-plugin-library-and-browser-plugins.md)), but making and changing them hasn't caught up (#60). The workshop runs only in the desktop app and deletes its work when it ends, a plugin can't be changed with the assistant once its workshop is gone, every library plugin is visible to everyone, and **Share to library…** uploads a plugin but installs it nowhere.

This ADR settles how that changes. A library plugin is **Shared** or **Only me**. Uploading your own plugin installs it for you. The workshop's files are saved on the server as a **plugin draft**, up to 10 per account, so work carries over between devices. The build moves from the desktop's main process to a worker in the page, so the workshop runs in the browser and on phones too, and **Change with the assistant** starts a draft from any library version's source.

"Plugin draft" is the term throughout, because pages have drafts of their own.

## What changes in ADR 0002

- Private library entries, which ADR 0002 left out, are in: a plugin is Shared or Only me. Only me hides it from other members' listing. Its files stay plain text on the server, and the operator can read them.
- Listing the library takes the hashes the caller has approved, so a plugin that went Only me stays listed, with its updates, for people who installed it.
- An upload installs the plugin for its owner. ADR 0002's uploads installed nothing.
- The workshop, which ADR 0002 kept out of the browser, comes to the browser and to phones. Its build runs in a worker in the page, in every client. Phones still can't upload a plugin folder, but they can publish a draft, which needs no folder.
- The file route also serves the caller's own plugin draft builds, as `/plugins/<id>/draft-<hash>/…`, so the browser previews a draft the way it loads a library plugin. The app's CSP doesn't change.
- On the desktop, main no longer keeps workspaces or builds. Installing a workshop version as a folder install, and the workshop's own **Share to library…**, give way to **Publish**. Folder installs, development loading and export to a folder stay.

Nothing here changes what the server can do to a person's plugins: approvals stay in the person's encrypted account record, and the desktop still checks every library download against the approved hash.

## What the code supports today

- **The library** (`packages/server/src/plugins/library.ts`, `apps/server/src/routes/plugins.ts`): `plugins` has one row per ID with its owner, `plugin_versions` one per hash, and the files live in `BLOB_DIR/plugins/<hash>/`. `listPlugins` returns every plugin with at least one version to every signed-in person. `pluginFile` serves a file to anyone signed in who names a version's ID and hash. An ID stays with its first uploader for good. Routes are people only (`routes.account`, `routes.file`), never agents.
- **Approvals** (`packages/client/src/operations/plugins.ts`): Install calls `approvePlugin(ctx, { id, hash, access: [] })`, and Update calls `updatePlugin(ctx, id, hash)`, which keeps page access and on or off (`Library` in `packages/ui/src/plugins/library-settings.tsx`). A browser runs an approval only if the listing has its version (`approvedPlugins` in `packages/ui/src/plugins/library.ts`), else Settings says it is no longer in the library. The desktop's main lists `GET /api/plugins` itself when it needs to download an approved version (`apps/desktop/src/plugins/library.ts`).
- **The workshop** (#257): main keeps a workspace per session under `userData/workshop` (`apps/desktop/src/workshop/workshop.ts`), with the limits of 200 files, 256 KB a file and 4 MB in all, plain paths at most five folders deep, and text kinds only (`.ts .tsx .js .jsx .json .css .svg .md .txt`). It builds in a worker thread (`builder.ts`, `build-worker.ts`) with esbuild-wasm's browser build, given every file in memory, resolving imports only to the workspace and `virtual:workshop-library` (the SDK's sources and React's production builds, read in by `apps/desktop/vite.config.ts`). Each build writes the manifest, `ui.js`, `script.js`, `public/`'s files and `source/<every workspace file>`, and is served as `/plugins/<id>/workshop-<session>-<n>/…`. Everything is deleted when the workshop ends, the window navigates or the app starts.
- **The workshop's page** (`packages/ui/src/workshop/`): `Workshop` drives main through the bridge, keeps the session's versions, and previews one in a runtime of its own (`createRuntime`) over sample pages held in memory (`samples.ts`). The runtime loads every plugin from `/plugins/<id>/<key>/<file>` (`fileUrl` in `runtime.ts`): `import()` for `ui.js`, `<link>` for styles, the sandboxed frame for `script.js`. The model's tools are in `packages/client/src/workshop-tools.ts`. The `/workshop` route says "The plugin workshop is in the desktop app" anywhere else.
- **The app's CSP** (`packages/contracts/src/security.ts`) has `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'` and `connect-src 'self'`, and the server sends it with every response, worker scripts included. The desktop app runs the same web build under `app://wikistow`. The web build already starts module workers from its own origin (`worker: { format: 'es' }` in `apps/web/vite.config.ts`). Static files under `/assets/` are cached for a year, and the server doesn't compress responses.
- **Backups** (`scripts/backup.sh`) take `pg_dump` and `BLOB_DIR`'s `objects/` and `plugins/`.

## Decisions

### 1. Shared or Only me

- **Where.** A column on `plugins`: `visibility text not null default 'shared'`, `'shared'` or `'private'`, so every existing plugin stays Shared. The interface says **Shared** and **Only me**.
- **Who sets it.** The owner. The upload body gains an optional `visibility`. On a new ID it sets it, defaulting to Shared, so older desktop apps share as before. On the owner's existing ID it changes it only when given. A new route, `PUT /api/plugins/:pluginId/visibility` with `{ visibility }`, changes it on its own, for the owner only: admins remove plugins, but who sees one is its owner's choice.
- **The listing.** `GET /api/plugins` takes an optional `have`, a comma-separated list of at most 100 hashes. It lists every Shared plugin, every plugin the caller owns, and any Only me plugin with a version whose hash is in `have`. Every client sends the hashes the person approved (they are in the account record, open once the vault is). So a plugin that goes Only me stays listed, with its newer versions, for each person who installed it, and their Update button still works. The listing's shape doesn't change, because older apps parse it strictly (`LibraryPlugin` is a strict object) and would refuse a new field, as the protocol already avoids for the share listing. Instead `GET /api/plugins/private` answers the IDs of the caller's own Only me plugins, and Settings shows **Only me** on those rows. An older desktop app, which sends no `have`, sees Shared plugins only and keeps the copies it installed.
- **The files.** #60 says an Only me plugin's files are served only to its owner, and also that people who installed it before it went Only me keep loading it and its updates. The server can't do both to the letter: it can't tell who installed a plugin without a record of who installed what, which ADR 0002 chose not to keep. So the file route doesn't change, and the hash is the key: any signed-in person who names a version's ID and hash gets its files. A SHA-256 hash can't be guessed, and the only ways to learn an Only me plugin's hashes are to own it, to have seen it while it was Shared, or to list it with a hash you already had. In effect, a plugin that was never Shared is served to its owner alone, and one that went Only me keeps loading for the people who installed it, and for anyone who kept one of its hashes from when it was Shared. That last group is the difference from #60's wording, and the cost of the plain route.
- **Going Only me stops new installs only.** People who installed it keep it and its updates. Going back to Shared lists it for everyone again. One exception, kept because the alternative is keeping removed hashes: if the owner of an Only me plugin removes the very version someone installed, it drops out of their listing, so they can't update or install it again. A removed version already stops loading in the browser (ADR 0002).
- **Admins** are members, so they don't see other people's Only me plugins either, as #60 says, and can't remove them from Settings. The owner can, and an admin who knows the ID can still call the remove route.

The server learns, at each listing, the hashes a person approved. It could already tell: every browser fetches the files it runs from the server, and every desktop downloads the versions it installs. It still keeps no record of them.

### 2. An upload installs the plugin for its owner

Only an ID's owner can upload to it, so after every successful upload (Settings' **Upload plugin folder…**, the desktop's **Share to library…**, the workshop's **Publish**), the client writes the person's approval the way Install and Update do: `approvePlugin(ctx, { id, hash, access: [] })` if the ID isn't installed, else `updatePlugin(ctx, id, hash)`, which replaces the older approved hash and keeps page access and on or off. The plugin then runs on all their devices from their next unlock, and on this one at once.

The hash approved is the one the client computed (`pluginHash`) from the files it sent, and it must equal the server's answer. If not, nothing is approved and the app says the server answered with different files. The approval is still shown before it is written, as ADR 0002 requires for every new hash. Each way of uploading has one confirmation, built from the approval dialog (`Approval` in `plugin-settings.tsx`): the plugin's name, version, trust level, most page access and hash, and for an update what changes from the installed version, plus Shared or Only me and a line saying it will be installed on all the person's devices. Confirming uploads and approves, so there is one dialog, not two. It serves Publish, Share to library, and Settings' **Upload plugin folder…**, which today uploads as soon as the folder is chosen. On the desktop, a folder install of the same ID still replaces it on that computer.

### 3. Plugin drafts on the server

**Schema.** One migration adds:

```
plugin_drafts
  id              uuid primary key
  owner_id        uuid not null, references users, on delete cascade
  name            text not null    -- the manifest's name as last saved, else "Untitled plugin"
  from_plugin_id  text             -- what it started from: a library version, or null
  from_hash       text             --   plain text, since the version may be removed later
  build_hash      text             -- the build a browser last previewed (decision 5), or null
  created_at, updated_at timestamptz
  index (owner_id, updated_at)

plugin_draft_files
  draft_id uuid references plugin_drafts on delete cascade, path text, text text, size integer
  primary key (draft_id, path)

plugin_draft_build_files
  draft_id uuid references plugin_drafts on delete cascade, path text, data bytea
  primary key (draft_id, path)
```

**Files in Postgres, not `BLOB_DIR`.** A draft's files are small text files changed one at a time. As rows, each change is one transaction that also checks the limits, deleting a draft or an account takes its files, nothing needs an orphan sweep, and `pg_dump` carries them, so `backup.sh`, `restore.sh` and the backup's check need no change. The build is up to 10 MB of bytes, still well within what one row holds; it goes with its draft the same way. The library keeps `BLOB_DIR` for its versions, which are immutable and served by hash for good.

**Limits.** The workshop's limits move from `apps/desktop/src/workshop/workshop.ts` into `packages/contracts`, and the server checks them: at most 200 files, 256 KB a file (in UTF-8) and 4 MB in all, each path plain (names of letters, digits, `_`, `.` and `-`, starting with a letter, digit or `_`, at most 64 characters, at most five folders deep), of a text kind, and not also a folder's name, as a build's paths can't be. A build is held to the library's limits (10 MB, 500 files, `script` at most 1 MB) and checked with `checkPlugin`. Drafts don't count against the storage quota; these limits bound them at about 140 MB per account.

**Ten per account.** Creating an 11th draft is refused with `draft-limit`, unless the request names `replaces`, one of the person's own drafts, which is deleted in the same transaction. The workshop warns first, naming the least recently changed draft: "You have 10 drafts. Starting this one deletes “Name”, the one you changed longest ago." with **Delete it and start** and **Cancel**. This is the issue's suggestion, and the server deletes nothing the person wasn't shown by name. A person who would rather lose another draft deletes it from the list first. "Changed" means its files: `updated_at` moves with each file change, not with a build.

**Routes** (`pluginDraftRoutes` in `packages/contracts/src/routes/plugin-drafts.ts`), people only, through `routes.account`. Agents never reach drafts. A draft that isn't the caller's answers `not-found`, the same as one that doesn't exist.

| Route | What | Rate limit |
| --- | --- | --- |
| `GET /api/plugin-drafts` | The caller's drafts, most recently changed first: ID, name, what it started from, file count, size, `updatedAt` | 120 a minute |
| `POST /api/plugin-drafts` | Create a draft, empty, from a library version (`from: { pluginId, hash }`) or from files (`files: [{ path, text }]`), with optional `replaces`. Answers its summary | 30 in 10 minutes, body 6 MB |
| `GET /api/plugin-drafts/:draftId` | The draft's summary and every file's text | 120 a minute |
| `POST /api/plugin-drafts/:draftId/changes` | `{ put: [{ path, text }], remove: [path] }`, applied together within the limits | 120 a minute, the app's usual 1 MiB body |
| `DELETE /api/plugin-drafts/:draftId` | Delete it, with its files and build | 120 a minute |
| `PUT /api/plugin-drafts/:draftId/build` | Replace the draft's build: every file, as an upload carries them. Answers its hash | 120 in 10 minutes, body 15 MB |
| `GET /plugins/<id>/draft-<hash>/<path>` | A file of the caller's own draft build with that hash and manifest ID, served by the library's file route | the file route's 2000 a minute |

A route with a body limit above the app's 1 MiB takes the account's one large-body slot for each request (`bodySlots` in `apps/server/src/http/mount.ts`), so the changes route, which carries one file of at most 256 KB, keeps the usual limit, and the model's writes never wait on an upload. The workshop sends its large uploads (a preview's build, Publish) one at a time.

A change that writes `wikistow-plugin.json` updates the draft's `name` from the JSON's `name` when it is a string (trimmed, at most 100 characters). A draft made from files or from a version takes its name the same way.

**From a library version.** The server copies the version's `source/` files, without the prefix, into the new draft and records `from`. Whoever may fetch the version's files may do this, so the same rule applies: the request names the hash. A version without `source/wikistow-plugin.json` (one built with the SDK, which doesn't write `source/`) is refused: "This version has no source to change. Its author can upload the project folder as a draft." If the caller doesn't own the plugin, the draft gets a new ID (decision 7).

**Backups.** `pg_dump` takes drafts with everything else, so nothing changes in the scripts. A restore brings back each draft's files and its build.

### 4. Saving

The workshop opens a draft by reading it whole (`GET`, at most 4 MB) and holds its files in memory. Each `write_file` and `delete_file` from the model is one request to the changes route, awaited before the tool answers, and the copy in memory changes only once the server has taken it. A refusal (a limit, a bad path) reaches the model as the tool's error, as main's refusals do now. So the draft on the server is always what the model last saw saved. Writes are not debounced like page autosave: the model writes whole files at a few distinct moments rather than keystrokes, and the person reads files in the workshop but doesn't type in them.

Two devices changing one draft: the last write of each file wins. An open workshop doesn't see the other device's changes until the draft is opened again. That is enough for one person's drafts among trusted users.

### 5. Building and previewing

**The build runs in a worker in the page.** `build-worker.ts` and `library.ts` move from `apps/desktop/src/workshop/` to `packages/ui/src/workshop/`, and the build worker becomes a module worker of the app's origin, started with the workshop's first build and ended with the workshop. It runs esbuild-wasm's browser build with `worker: false`, so esbuild runs inside it: with `worker: true` esbuild starts a `blob:` worker of its own, which the CSP refuses. WebAssembly compiles under the existing `'wasm-unsafe-eval'`. The spike below built a real plugin this way in Chromium, Firefox and WebKit under the app's exact CSP. `virtual:workshop-library` moves from the desktop's Vite config to the web build's, imported only by the build worker, so only someone using the workshop downloads it, and `esbuild.wasm` becomes a web build asset under `/assets/`. The desktop runs the same web build, so it uses the same worker: there is one build path. The worker only bundles; it never runs plugin code.

**What a build makes doesn't change:** the manifest, `ui.js`, `script.js`, `public/`'s files at the top, and every draft file under `source/`, so a published version carries its source and can be changed with the assistant later. The page checks it with `checkPlugin` and the library's limits, so a build that couldn't be published fails as a build, and hashes it with `pluginHash`. The page keeps every version this conversation built, with its files, so any can be previewed again or published, as the Versions list does now. They go with the conversation.

**Previewing in the browser.** The page uploads the version's files with `PUT …/build`. The server checks them as it checks a library upload and keeps them as the draft's one build, replacing the last. Its answer must be the hash the page computed. The preview's runtime then loads the version from `/plugins/<id>/draft-<hash>/…`, which the file route serves from the draft's build to its owner only, with the library's headers: `import()` for `ui.js`, `<link>` for styles, the sandboxed frame for `script.js`, exactly as it loads library plugins. The runtime is unchanged: a draft build's key is `draft-<hash>`. Not the bare hash, which the installed copy of the same version uses: browsers keep one module per URL, so a preview and an installed copy under one address would share a module, and with it the plugin's state and host. Caching it for good is right, since a hash's files never change.

**Previewing on the desktop.** The page hands the version's files to main (`workshopPreview(files)`). Main checks every path with `PluginFile`, refuses a file with a folder's name and the library's limits, as `uploadPlugin` and the plugin store do, since `checkPlugin` leaves paths and limits to its caller and app code runs in the same page, then checks the files with `checkPlugin`, keeps them in `userData/workshop/<hash>/`, and serves them under `app://wikistow/plugins/<id>/draft-<hash>/` as it serves workshop versions now. It deletes them when the window navigates and when the app starts, as now. Whether it holds any is what tells main a preview ran in the window, which its crash check uses to choose safe mode (`previewing` in `render-process-gone`, `workshop.open()` today). Handing the files over is shorter than having main fetch them from the server and check them, and main serves only what the page built. The desktop doesn't upload builds.

So the draft's build on the server is the one a browser last previewed: a cache for serving, which nothing else reads. A draft opened on another device is built again in the page (about half a second to a second), never served from that cache unbuilt.

**Publishing** uploads the files of the version in the preview with the library's upload route, with the person's choice of Shared or Only me, then writes the approval (decision 2). It doesn't copy the server's draft build, since the desktop doesn't upload one, and the upload route already has every check. From a phone that is at most 10 MB, usually a few hundred KB. The draft stays after publishing, so the person can carry on and publish the next version.

**What the server can do.** The workshop has always taken its code from the server, through the AI proxy that carries the model's replies. Drafts on the server give it nothing more. Opening a saved draft builds and previews it without the assistant: its script runs in the sandboxed frame, and its app code runs only once the person allows it, as now. Installing still binds to a hash the client computed, and the desktop still checks every library download against it.

### 6. The workshop's lifetime and disclosure

The conversation lasts as it does now: until **End workshop**, locking the vault, signing out, or reloading or closing the app. The draft stays; **End workshop** no longer deletes anything. The workshop page lists the person's drafts, with **Open**, **Delete** and how long ago each changed, beside **New plugin**.

The disclosure in `workshop-panel.tsx` keeps its first paragraph and replaces the second with: "The plugin’s files are saved as a draft on your WikiStow server as the assistant writes them, so you can carry on from any device. Like library plugins, they’re plain text on the server. The conversation isn’t saved: it ends when you end the workshop, lock your vault, sign out, or reload or close the app." The model's system prompt drops "in the desktop app" and says the files are saved as they are written.

**Sample pages stay on the device**, in the page's memory, and go with the conversation as now. They never go into the draft: a sample can be a copy of a real page, which is encrypted everywhere else. A new conversation on a draft starts with the default samples, and the model writes its own as before.

### 7. Change with the assistant

- In Settings → Plugins, each library plugin's newest version offers **Change with the assistant**, shown only when the version has source (its `files` list `source/wikistow-plugin.json`). It makes a draft from that version (with the 10-draft warning if needed) and opens the workshop on it.
- **Your own plugin** keeps its ID. Publishing adds a version, and the people who installed it see the update to approve, as now.
- **Someone else's plugin** gets a new ID of the person's own when the server makes the draft, so the preview and its sample blocks use it from the start. The server writes the first of `<id>-copy`, `<id>-copy-2`, `<id>-copy-3` and so on that no account has claimed (no `plugins` row, whether listed, Only me or with every version removed) and that none of the person's other drafts names in its manifest into the draft's `wikistow-plugin.json`, shortening `<id>` so the whole stays within the ID's 40 characters. It changes nothing else in the source.
- **Checked at Publish.** IDs aren't reserved for drafts, so another copy may publish the same ID first. The upload route refuses an ID another account owns, and Publish shows its message ("Another account owns the plugin ID …"); the person asks the assistant for another ID and publishes again.
- A copy is a different plugin: pages' `plugin:<old-id>/…` blocks and `plugin.<old-id>` data aren't its own. When a draft started from someone else's plugin, the workshop says so once, and the model is told the old and new IDs.

### 8. SDK projects

**Upload project folder…**, on the workshop page, makes a draft from a project built by hand with the SDK. It uses the same folder input as the library's upload, in a computer's browser and in the desktop app; a phone says it needs a computer. It takes `wikistow-plugin.json` at the top and every file under `src/` and `public/`, and leaves everything else out (`package.json`, `node_modules`, `dist`, dotfiles), filtering by path before reading anything. A file under `src/` or `public/` the draft can't hold (its kind, its path, its size) or the limits refuse the whole upload, naming the file; a folder without `wikistow-plugin.json` at the top asks for a plugin project's folder. `wikistow-plugin build` still doesn't write `source/`, as decided. The workshop resolves only the project's own files, the SDK and React, so a project that imports other packages fails to build there, with the message naming the import.

### 9. The desktop

- **Stays:** folder installs, development loading, **Share to library…** on a folder install (now installing it for the owner), export of a workshop version to a folder, and serving previewed builds. Export hands the version's files and hash to main (`workshopExport(files, hash)`), which checks them as `workshopPreview` does and against the hash, asks for a parent folder and writes `<id>-<first 8 characters of the hash>`, since a conversation's version numbers no longer name anything lasting.
- **Goes from main:** workspaces and sessions (start, end, files, read, write, delete, build, cancel), `builder.ts`, `build-worker.ts`, `library.ts` and `virtual.d.ts`, the `virtual:workshop-library` plugin and the `esbuild.wasm` copy in `apps/desktop/vite.config.ts`, `esbuild-wasm` as a dependency of `apps/desktop`, and the bridge's workshop channels except `workshopPreview` and `workshopExport`. Installing a workshop version as a folder install and the workshop's **Share to library…** go too: **Publish** does both, on every device.

### 10. Phones

At phone sizes the `/workshop` page is one column at full width: the drafts list, then, in a workshop, the preview card with its version, consent, themes, sample pages, versions and files stacked. The conversation is the assistant's sheet, as the page chat's is below 1200 px, and its header's **Open the preview** closes the sheet. **Publish** works on a phone, since a draft needs no folder. The first build on a device downloads `esbuild.wasm`, 14 MB (3.7 MB if a proxy in front of the server compresses it), then cached for a year.

### Out of scope

Saving the conversation or the sample pages, merging two devices' changes to one draft, drafts shared between accounts, proposing a change back to someone else's plugin, sweeping drafts by age, encrypted drafts, binary files in drafts, and a server-side publish from a draft's build.

## Spike evidence (2026-10-16)

A throwaway server sending the app's exact CSP and headers with every response, a page starting a module worker from its own origin, and in it esbuild-wasm 0.28.2's browser build with the desktop's workshop library (the SDK's sources and React 19.3's production builds) and a copy of its confined resolver, building `examples/plugins/page-tools` (`ui.tsx` with React, and `script.ts`) twice. Playwright 1.63's browsers; WebKit in the CI Playwright image.

| Question | Chromium 153 | Firefox 155 | WebKit 26.6 |
| --- | --- | --- | --- |
| esbuild-wasm initialises in a page module worker under the CSP (`worker: false`) | yes, 181 to 225 ms | yes, 445 ms | yes, 276 ms |
| Builds `ui.js` (679 KB with React) and `script.js` (8 KB): first, then again | 1.1 s, then 0.5 s | 0.6 s, then 0.5 s | 0.6 s, then 0.5 s |
| CSP violations while doing so | none | none | none |
| esbuild's own `worker: true` (a `blob:` worker) | refused, `worker-src` | no answer | refused, `worker-src` |

Phones run these engines (Chrome on Android, WebKit on iOS); D4 checks the workshop on the Android emulator.

## Considered options

- **The file route checks the owner for Only me plugins.** It would stop serving people who installed it, against Scott's decision, unless the server kept a record of who installed what, which ADR 0002 chose not to keep.
- **Listing Only me plugins by ID** for anyone who names it. Plugin IDs show in pages' block fences (`plugin:<id>/…`), so anyone reading such a page could list and install it. A hash is known only to people who could already see a version.
- **Drafts' files in `BLOB_DIR`,** like the library's. It needs atomic file writes, a sweep for orphans, a backup change and a check in it, for files that are small, textual and changed one at a time.
- **The server sweeping the oldest draft by itself,** or drafts older than some age. It would delete work the person wasn't shown. Scott's rule is per count.
- **Debounced saving,** as pages autosave. The model's writes are whole files at a few moments; one request each is simpler and loses nothing on a reload.
- **The desktop fetching the draft build from the server,** checked against the page's hash, as it fetches library copies. It is more code in main and another request for files the page already holds.
- **Publishing from the server's copy of the draft build.** It saves an upload from phones, but the desktop would have to upload every build it previews, and the publish route would repeat the upload route's checks.
- **A separate path for draft builds,** such as `/plugin-drafts/<draftId>/<hash>/…`. The runtime would need a base URL per plugin; under the library's path a draft build is just another key, `draft-<hash>`.
- **A draft build keyed by its bare hash.** One path fewer to parse, but the preview and an installed copy of the same version would import one URL, and so share one module, its state and its host.
- **Choosing the new ID at Publish** for someone else's plugin. The preview, its sample blocks and the model would use the old ID until then, and changing the manifest at the end changes the hash the person reviewed.

## Consequences

- The server stores plugin drafts in Postgres, up to 10 per account, plain text like library plugins, in the backups.
- The web build gains the build worker, the workshop library and `esbuild.wasm` (14 MB, fetched only by the workshop). The desktop's main process loses its workshop code and `esbuild-wasm`.
- The library's listing request carries the caller's approved hashes, and its response keeps its shape; an older desktop app doesn't send them and sees Shared plugins only.
- The spec (`wikistow.md`), `wikistow/ui-design.md` (Settings → Plugins, the workshop at computer and phone sizes), `wikistow/CONTEXT.md` (**Plugin draft**, Shared and Only me) and `packages/plugin-sdk/README.md` (the workshop is no longer desktop only; uploading a project as a draft) change with the pull requests that build them.

## Decided (2026-10-16)

Scott decided the direction in #60 on 2026-10-16 and asked for it to be built and merged as needed. These follow from his decisions there:

1. Visibility is a column on `plugins`, Shared by default, set by the owner at upload or with its own route.
2. The listing takes the caller's approved hashes and lists an Only me plugin to its owner and to anyone who names one of its versions' hashes; its response keeps its shape. The file route stays as it is for library versions: the hash is the key.
3. Every upload installs the plugin for its owner, with the hash the client computed, replacing an older approved version and keeping its access, after one confirmation that shows what the approval dialog shows.
4. Plugin drafts live in Postgres, files and one build, with the workshop's limits, people only, in the backups through `pg_dump`.
5. At most 10 drafts; an 11th replaces the least recently changed one the person is shown and agrees to lose.
6. Each model write saves at once; the last write of a file wins.
7. The build runs in a module worker in the page, esbuild-wasm with `worker: false`, in every client. The browser previews from the file route under `draft-<hash>`, owner only; the desktop's main serves what the page hands it under the same key.
8. Publish uploads the previewed version from the page, Shared or Only me.
9. A draft of someone else's plugin gets `<id>-copy` (or `-copy-2` and on) when it is made; the upload's ownership check is the final word.
10. An SDK project becomes a draft from its `wikistow-plugin.json`, `src/` and `public/`.

## Implementation, in pull requests

Each pull request keeps the spec, `ui-design.md`, `CONTEXT.md` and the SDK's README in step with what it builds, adds its line to the changelog, and follows the testing standard: permanent tests only for permission checks and what else meets it, temporary checks and screenshots for the rest.

1. **D1, Shared or Only me, and installing what you upload** (`plugin-visibility`). Server: the `visibility` column and its migration, `listPlugins` taking `have`, `uploadPlugin` taking `visibility`, the owner's Only me IDs, and `setPluginVisibility` for the owner (`packages/server/src/plugins/library.ts`, `packages/server/src/db/schema/plugins.ts`, `apps/server/src/routes/plugins.ts` except the file handler). Contracts: `listPlugins`' query, `uploadPlugin`'s body, `GET /api/plugins/private` and `PUT /api/plugins/:pluginId/visibility` (the route contracts have no `PATCH`), with `LibraryPlugin` and the listing's response unchanged (`packages/contracts/src/routes/plugins.ts`). Clients: every listing sends the approved hashes (`libraryQuery`, keyed by them, and `librarySource` in `packages/ui/src/plugins/library.ts`; the listing in `apps/desktop/src/plugins/library.ts`); one helper after every upload that checks the answered hash and writes the approval, used by Settings' upload and the desktop's **Share to library…**. Settings → Plugins: **Only me** on the owner's rows with a way to change it, and one upload confirmation built from `Approval` (level, access, hash, what an update changes) with the choice and the line saying it is installed on all your devices, replacing `ShareToLibrary` and newly in front of Settings' folder upload (`library-settings.tsx`, and its callers in `plugin-settings.tsx` and `workshop-preview.tsx`). D1 owns that dialog; D3 deletes the workshop's call of it. Integration tests for the listing rule (another member doesn't see an Only me plugin, does with one of its hashes, the owner always does) and for only the owner changing visibility. Screenshots of Settings at computer and phone sizes. Starts once this ADR is merged.
2. **D2, plugin drafts on the server** (`plugin-drafts-server`). The draft tables and their migration (`packages/server/src/db/schema/plugin-drafts.ts`), the store (`packages/server/src/plugins/drafts.ts`: list, create empty, from files or from a version's `source/` with the new ID for someone else's plugin, read, change within the limits, delete, the `replaces` rule, the build), the routes (`apps/server/src/routes/plugin-drafts.ts`), the build's checks taken out of `uploadPlugin` into one function both use (`checkUpload` in `packages/server/src/plugins/library.ts`: duplicate paths, a file with a folder's name, the size, `checkPlugin`, the script limit), `pluginDraftRoutes` with the limits and path rule moved into contracts, and the file route serving `draft-<hash>` keys from the caller's draft build (only the file handler in `apps/server/src/routes/plugins.ts`). No interface, and no client module beyond the contracts: the interface calls the routes with `api.call`, as it does the library's. Integration tests that another member and an agent can't list, read, change, delete, build or fetch a draft's build files, that an 11th draft needs `replaces`, and that the limits hold. Backups need no script change; check once that a restore brings a draft back, or add it to `m4-restore` if that meets the standard. Starts once this ADR is merged, beside D1; whichever merges second renumbers its migration and rebases over the other's lines in `apps/server/src/routes/plugins.ts`, `uploadPlugin` and the schema index.
3. **D3, the workshop on drafts** (`workshop-drafts`). The build worker and the workshop library in `packages/ui/src/workshop/`, with `virtual:workshop-library` and `esbuild.wasm` in `apps/web/vite.config.ts` (the resolver in both `plugins`, for the dev server, and `worker.plugins`, which a build bundles workers with), `virtual.d.ts` moved beside the worker, and `esbuild-wasm` moved to the web side. `Workshop` on a draft: opened by ID, files in memory, each write saved, builds in the page, versions held in the conversation, previewed under `draft-<hash>` through `PUT …/build` in the browser and `workshopPreview` on the desktop, sending one large upload at a time. `workshop-tools.ts` and the system prompt updated. The `/workshop` page lists drafts with **New plugin**, **Open** and **Delete**, warns before an 11th, and opens in a computer's browser as well as the desktop. The new disclosure. Desktop: main's workshop code goes (decision 9), with `workshopPreview` and `workshopExport` left in `main.ts`, `preload.ts` and the contracts' bridge, and the crash check's `previewing` asking whether main holds previewed builds. The workshop's Install and **Share to library…** go; D4 adds Publish, and nothing is released in between. No e2e covers the workshop today; its tests are `apps/desktop/test/workshop.test.ts`. Its confinement case becomes a test that `workshopPreview` and `workshopExport` refuse unsafe paths and that main serves nothing outside a previewed build (`..%2f` under a `draft-` key), its check that export writes only the version reviewed stays, against the hash, and its install case goes with the code. Evidence: temporary browser checks that a draft survives a reload and opens in a second browser, and that the preview loads from the file route under the CSP; screenshots of the drafts list and the workshop. Needs D2.
4. **D4, the workshop everywhere, Change with the assistant, Publish** (`workshop-everywhere`). The workshop page at phone sizes (decision 10). **Publish** in the workshop with Shared or Only me and the ID message for copies, through D1's upload confirmation and install helper. **Change with the assistant** in Settings → Plugins. **Upload project folder…** on the workshop page. Spec, `ui-design.md`, `CONTEXT.md` and the SDK README brought up to date, and this ADR's status set to `built`. Evidence: screenshots at computer and phone sizes, a check on the Android emulator, and one browser e2e of the whole journey (make, reload, open again, publish, installed) at computer size if it meets the testing standard. #60's order asks for browser e2e at phone and computer sizes and desktop e2e; the testing standard decides instead, so phone sizes and the desktop get temporary checks and screenshots unless a failure there meets it. Closes #60. Needs D1 and D3.

D1 and D2 run side by side; D3 needs D2; D4 needs D1 and D3.
