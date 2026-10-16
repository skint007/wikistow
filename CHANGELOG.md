# Changelog

What changed in each WikiStow release, newest first. The app's **What's new** page shows each release's highlights, and each GitHub Release's notes are made from its entry here. [Releasing](docs/releasing.md#the-changelog) says how to write an entry and when.

## Unreleased

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
