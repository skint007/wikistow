# Changelog

What changed in each WikiStow release, newest first. The app's **What's new** page shows each release's highlights, and each GitHub Release's notes are made from its entry here. [Releasing](docs/releasing.md#the-changelog) says how to write an entry and when.

## Unreleased

### Highlights

#### Features

- A new server asks for its administrator the first time you open it. That account signs in straight away, before mail is set up. The `bootstrap-admin` command is gone.

### Changes

#### Server

- The first account on a new server becomes its administrator. While the server has no accounts, sign-in and `/` open **Set up WikiStow**, `GET /api/installation` reports `setup: true`, and `POST /api/setup` creates the account under the admin lock, with its address counted as verified. It refuses once any account exists. The `bootstrap-admin` command, `admin.mjs` and the `bootstrap` invitation kind are gone, and open bootstrap links are withdrawn. (#PR)

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
