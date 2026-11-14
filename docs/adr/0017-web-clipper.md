---
status: accepted
---

# Clipping from the browser, through the desktop app

A browser extension should save what's in the browser to WikiStow: a link with a note, the selected text, a simplified article, the whole page, or a screenshot (#406). The issue's decisions bind this ADR: the extension holds no keys, tokens or agent identity; it hands each clip, as plain text, to the person's WikiStow desktop app through the browser's **native messaging**; the app makes the page as a **draft**, as the signed-in person, sealed like any page; the app opens no network port (Decide 2); the extension is published to the Chrome Web Store and Mozilla Add-ons; clipping needs the desktop app, and when the app is closed or locked the extension says so and can open it. The server doesn't change. This ADR decides the native messaging host, how it reaches the running app and starts a closed one, the host manifests for each browser and system, trust, the message format and its limits, the clip modes and where HTML becomes Markdown, choosing a folder, the closed, locked and browser-only cases, and store review.

In short:
- **A small helper, `wikistow-clip-host`, is what the browser starts.** It is a separate executable of a few megabytes, written in Go, shipped inside every desktop package. It only relays: it copies framed messages between the browser and the running app, and it starts the app when it's closed. It holds no keys and keeps nothing.
- **It reaches the app through a local socket, behind a token.** The running app's main process listens on a Unix domain socket in a folder only the person can open, or a named pipe on Windows, and writes its name and a random token to a file only the person can read. The helper and the app each prove they hold the token before anything else crosses. The app opens no network port of its own, and no web page can reach it. Whether this fits the spec's "runs no local server" is Decide 2.
- **The app's pages do the work.** Main hands each clip to the window, where the person's keys are. The page turns its HTML into Markdown the way a paste does, makes a new page as a draft with the page writer, so it queues offline like any new page (ADR 0009), and seals the clip's images as its attachments.
- **The app writes the host manifests** at each launch, for each of Chrome, Chromium, Edge, Brave and Firefox it finds, per user, naming only the published extension IDs. Settings can turn clipping off, which removes them.
- **No approval prompt.** Only the extensions the manifest names can start the helper, and pages can't reach it at all. Every clip lands as a draft, and the app says where.
- **Folders are searched, not listed.** The extension asks the app for folders matching what the person types, and gets at most 50 matches back, with the five folders used last, while the app is unlocked. The extension keeps no folder names on disk.
- **The extension asks only for** `nativeMessaging`, `activeTab`, `scripting`, `contextMenus` and `storage`, and no host permissions. The app, not the extension, downloads a clip's images.

## What the code supports today

- **One instance.** `main.ts` takes Electron's single-instance lock (line 106). A second launch hands its arguments to the first and quits. The first gets them as `second-instance` (line 709), focuses its window, and takes a `wikistow://` sign-in link (`linkArgument`) or `--safe-mode`. A Mac delivers links as `open-url` (line 703). The handoff is one-way: the second launch gets no answer. Closing the one window quits the app (`window-all-closed`, line 732).
- **No listener.** The main process opens no port or socket of its own. It serves `app://wikistow` through `protocol.handle`, and refuses `/api/*` requests whose `Origin` or `Sec-Fetch-Site` isn't the app's own (`serve`). The spec says the desktop package runs no local server (`wikistow.md` line 57).
- **The keys are in the pages.** The vault opens in the renderer. Main holds the session cookie, the remembered vault key only if the person asked for one (`rememberVault`), and files the pages sealed, such as the search index, which it can't read. Main sends the page events through the preload bridge (`onFind`, `onWindowState`). The page calls main through `handle`, which refuses any frame not from `app://wikistow`.
- **Two apps.** The AUR's beta installs beside the stable app, with its own name, data folder, single-instance lock and `wikistow-beta://` links (`install.ts`, `docs/desktop.md`).
- **Packages.** The AUR package is the app's `app.asar` on Arch's `electron44`. The `.deb` and `.rpm` bring their own Electron into `/usr/lib/wikistow-desktop`. The Windows installer installs for the person alone into `%LOCALAPPDATA%\Programs\WikiStow Desktop`, writes only `HKCU` keys (the `wikistow://` handler and the uninstall entry), deletes every top-level file of the folder on each update, and its uninstaller deletes its keys. It is built on Linux, since "the app has no native modules" (`scripts/windows-packages.sh`). The Mac app is a zip, or a Homebrew cask, with no installer, signed ad hoc with `codesign --deep` (`scripts/macos-app.sh`). The Windows and Mac apps aren't signed by a publisher yet (#325).
- **Making a page.** `createPage` (`packages/client/src/operations/pages.ts` line 208) makes a page as a draft (`audience: 'draft'`, `basedOn: null`). `uploadAttachment` (line 1014) seals a file to the page's draft. `createFromTemplate` makes a page first and attaches files after, as uploading needs the page. In the app, `pageWriter` (`packages/ui/src/data/offline-changes.ts`) makes pages (`newPage`), attaches files (`attach`) and saves drafts (`draft`), to the server or, offline, into the queue (ADR 0009).
- **Limits.** A version's Markdown is at most 256 KiB (`MAX_MARKDOWN_BYTES`), its payload 512 KiB, and it lists at most 200 attachments (`MAX_ATTACHMENTS`). One upload is at most `MAX_UPLOAD_MIB`, 25 MiB by default.
- **Pasted HTML.** `unstyled` (`packages/ui/src/page/editor/visual/pasted-html.ts`) cleans pasted HTML: no styles, only what a browser shows, the image a browser shows. The visual editor's `transformPastedHTML` (`visual/plugins.ts`) hands it to ProseMirror, which keeps what the schema can hold, and the writer writes it as Markdown. All of it needs a DOM and runs in the open editor.
- **The policy** allows `img-src 'self' blob:` and `connect-src 'self'` (`packages/contracts/src/security.ts`), so a page never loads an image from another site, and the renderer can't fetch one.
- **Import** writes a Joplin note's source address as the `source` property (`wikistow.md`, **Import**).
- **Nothing captures from the browser,** and there is no extension code in the workspace.

## Decisions

### 1. The native messaging host

The browser starts the program a host manifest names, with its standard input and output as the channel, and passes the caller as arguments: Chrome the extension's origin, and on Windows `--parent-window`; Firefox the manifest's path and the extension's ID ([Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)). `connectNative` keeps the program running until the port closes. Then, on Linux and macOS, Firefox sends it `SIGTERM` and later `SIGKILL`, which "propagate to any subprocesses unless they break away into a new process group". On Windows it kills the Job object it put the program in, with any process started in it, unless that process was started with `CREATE_BREAKAWAY_FROM_JOB` (MDN). In the spike, Chromium ended only the host: a process the host started in its own group lived on. The helper exits as soon as its standard input closes. A manifest can pass no arguments or environment of its own.

**What the browser starts.**
- **A. The Electron app, with a flag.** One executable, and the app's own TypeScript. But each start is a whole Electron: in the spike, 133 ms to answer and 122 MB of memory per connection, against 6 ms and 2 MB for a small helper. It also can't be the app itself. The browser ends it when the port closes, and on Windows Firefox's job ends what it starts too. So it would still be a relay to a second, real app, and that relay would have to get past the single-instance lock, which hands over only one way. On Windows, an Electron app's standard streams as a native host are untested.
- **B. Electron run as Node** (`ELECTRON_RUN_AS_NODE=1`), behind a shell script, or a `.bat` file on Windows. TypeScript again, and no new toolchain. But 61 ms and 79 MB per connection in the spike, and it keeps Electron's `runAsNode` fuse on for good, which Electron's hardening advice turns off. The AUR's system `electron44` is not ours to change either way.
- **C. A small separate helper** (recommended). It does one thing: relay framed messages, and start the app when it's closed. In the spike, a 374 KB Rust build answered in 6 ms with 2 MB of memory. Bitwarden's desktop app ships the same shape: a small `desktop_proxy` beside its Electron app, which relays to the running app over a socket or named pipe ([Bitwarden](https://github.com/bitwarden/clients/blob/main/apps/desktop/src/main/native-messaging.main.ts)). KeePassXC's `keepassxc-proxy` does the same.

**In Go.** The repository has no compiled code. The Windows installers are built on Linux, and the Mac app on Mac runners (`scripts/macos-app.sh`). Go builds every target from Linux (Linux x86_64, Windows x64 and arm64, macOS arm64 and x64) with no C toolchain or Apple SDK, so the Windows helpers join the installers where they're built, and the Mac helpers are built anywhere and signed with the app. On Windows, Go's standard input and output are raw handles, so the text-mode corruption Chrome warns about doesn't arise. Windows serializes reads and writes on a handle opened without overlapped I/O, so a pipe read and written at once needs it: the helper uses Microsoft's `go-winio` there, and step 2 tests a read waiting while a write goes out. Rust, which the spike used, needs a cross linker or Windows runners for Windows, and its Mac helpers would build on the Mac runners, as the app does. The helper is a few hundred lines in either. Decide 1.

**Where it is.** `/usr/lib/wikistow-desktop/wikistow-clip-host` (the beta's in `/usr/lib/wikistow-desktop-beta`), from the `.deb`, `.rpm` and AUR packages; `wikistow-clip-host.exe` beside `WikiStow.exe` on Windows; `WikiStow.app/Contents/MacOS/wikistow-clip-host` on a Mac, signed ad hoc with the app. It finds its app's data folder from its own place, as `install.ts` tells the beta from the stable app. The host names are `io.github.skint007.wikistow` and `io.github.skint007.wikistow_beta`, after the Mac app's bundle ID. Host names allow only lowercase letters, digits, `_` and `.`. One extension serves both apps: it tries the stable host, then the beta's, and uses the first whose app answers `ready`, or else the first installed. Its settings can pin one, for someone who runs both.

**How it reaches the running app.**
- **A. The single-instance handoff.** It already exists, but only an Electron launch can use it, the first instance gets the arguments and can't answer, and the second launch quits. A clip needs an answer: saved, locked, the folders found.
- **B. A file drop.** The helper writes the clip into a folder the app watches, and reads the answer from another file. No listener at all, but the clip sits on disk unencrypted, maybe in backups, and status and folder search become slow file round trips.
- **C. A local socket, behind a token** (recommended). The app's main process listens, while clipping is on and the app runs:
  - on Linux, on a Unix domain socket in `$XDG_RUNTIME_DIR/wikistow` (`wikistow-beta`), a folder of mode `0700`, or in the data folder without one;
  - on a Mac, in the data folder, under a short name, as a socket's path must stay under 104 bytes. Not in the per-user temporary folder, whose old files macOS deletes;
  - on Windows, on a named pipe, `\\.\pipe\wikistow-clip-<random>`.

  Once main listens, before the window loads, it writes `clip-host.json`, mode `0600`: the socket's path and a fresh 32-byte token. On Linux and macOS it goes in the data folder. On Windows it goes in `%LOCALAPPDATA%\WikiStow Desktop`, which only the person can read, rather than the data folder in `%APPDATA%`, which roams and can be redirected to a file server. The app deletes it when it quits. The helper reads that file and connects, and each side proves it holds the token without sending it:
  1. Before anything else, the helper checks who serves the socket: its user must be the helper's own (`SO_PEERCRED` on Linux, `getpeereid` on macOS, `GetNamedPipeServerProcessId` and that process's owner on Windows).
  2. The helper sends a random nonce `Nh`. The app answers with its own nonce `Na` and `HMAC(token, "app" ‖ Nh ‖ Na)`.
  3. The helper checks that, and answers `HMAC(token, "helper" ‖ Na ‖ Nh)`.

  Each MAC names its role and both nonces, so one connection's answer can't be replayed or bounced into another. A client without the token can make the app compute a MAC, but never the helper's. Both sides compare MACs in constant time. A side that fails, or takes over a second, is dropped. Only then does the helper copy frames both ways, unread. On Windows the helper opens the pipe with an anonymous security level (`SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS`, as `go-winio` dials), so a pipe someone else made can't act as the person.

  On Linux and macOS, the folder's mode keeps other accounts out. On Windows, any account can list the pipes' names, so the name hides nothing. Node makes a pipe with Windows' default security, which grants "full control to the LocalSystem account, administrators, and the creator owner" and "read access to members of the Everyone group and the anonymous account" ([named pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)). So another account can open it only to read, can't send a nonce, and gets nothing; the app never makes the pipe with Node's `writableAll`. Node doesn't set `PIPE_REJECT_REMOTE_CLIENTS`, so where Windows shares files (SMB, port 445), another computer can open the pipe the same way, read-only, and can't read `clip-host.json` either. Step 2 checks the pipe from a second account and from another computer. No web page can reach a socket or a pipe, and the app opens no network port of its own. It is still a listener the app didn't have, which Decide 2 asks about.

**When the app is closed.** The helper finds no `clip-host.json`, or can't connect. It answers `hello` itself with `{"type": "status", "app": "closed"}`, and on `open` starts the app outside the browser's reach, with no standard input or output of the helper's, so nothing the app prints reaches the browser's pipe or holds it open. It connects once `clip-host.json` appears, within 60 s in all, then passes on the app's `status` as it changes (decision 7):
- Linux: the package's launcher (`/usr/bin/wikistow-desktop`, or `wikistow-desktop-beta`), in a new session (`setsid`), so the signals Firefox sends to the helper's process group miss it;
- macOS: `open -a` on its own bundle, so Launch Services starts the app, not the helper;
- Windows: `WikiStow.exe` with `CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS`. If a job refuses breakaway, the helper asks the running Explorer to start it (`explorer.exe` with the app's path), and failing that says so, and the extension asks the person to open WikiStow from the Start menu. Step 2 checks both browsers.

If the app was running after all, the second launch hands over to it and quits, as today. A development build has no launcher, so its helper can't start it.

**Showing the window.** On `open` to a running app, and when a clip waits for unlock, the app brings its window forward. A process in the background can't always take the foreground: on Windows the helper allows the app's process (`AllowSetForegroundWindow`) as it hands over; on a Mac the app uses `app.focus({steal: true})`; on Wayland a compositor may only flag the window, as GNOME does without an activation token. So the extension always says **Switch to WikiStow to unlock**, and step 2 checks each.

### 2. Installing the host manifests

A manifest names the host, the absolute path to the helper (a relative one is allowed only on Windows), `"type": "stdio"`, and the extensions allowed. Chromium browsers look for per-user manifests in their profile folders, or on Windows in the registry, whose default value is the manifest's path; Firefox the same in its own places ([Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [MDN: native manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests), [Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)).

| Browser | Linux (`~/.config` is `$XDG_CONFIG_HOME`) | macOS (`~/Library/Application Support/…`) | Windows (`HKCU\Software\…`) |
| --- | --- | --- | --- |
| Chrome | `~/.config/google-chrome/NativeMessagingHosts/` | `Google/Chrome/NativeMessagingHosts/` | `Google\Chrome\NativeMessagingHosts\<name>` |
| Chromium | `~/.config/chromium/NativeMessagingHosts/` | `Chromium/NativeMessagingHosts/` | `Chromium\NativeMessagingHosts\<name>` |
| Edge | `~/.config/microsoft-edge/NativeMessagingHosts/` | `Microsoft Edge/NativeMessagingHosts/` | `Microsoft\Edge\NativeMessagingHosts\<name>` |
| Brave | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `BraveSoftware\Brave-Browser\NativeMessagingHosts\<name>` |
| Firefox | `~/.mozilla/native-messaging-hosts/` | `Mozilla/NativeMessagingHosts/` | `Mozilla\NativeMessagingHosts\<name>` |

Edge on Windows falls back to Chromium's and Chrome's keys when its own is missing. Brave doesn't document its key; Bitwarden writes it, with Chrome's, Chromium's, Edge's, Vivaldi's and Firefox's. The browsers read the registry's 32-bit view before its 64-bit one, but `HKCU\Software` is one key in both views, so one write serves every browser.

**When.**
- **A. The packages install them.** The Linux packages could own system-wide manifests (`/etc/opt/chrome/native-messaging-hosts`, `/etc/chromium/native-messaging-hosts`, `/etc/opt/edge/native-messaging-hosts`, `/usr/lib/mozilla/native-messaging-hosts`), removed with the package and present before the first launch. But Brave's system folder isn't documented. A Mac has no installer, and the person can move the app. Only the Windows installer could do the same there.
- **B. The app writes them at each launch** (recommended), per user. On Linux and macOS, that is for each browser whose profile folder exists. Firefox's is `~/.mozilla`, or `~/.config/mozilla` for newer profiles, where the app makes `~/.mozilla/native-messaging-hosts` as Bitwarden does; on a Mac, its profiles are in `…/Firefox/` and its manifests in `…/Mozilla/`. On Windows it writes all five keys, which cost nothing where a browser is missing. One way on every system, which follows the app when it moves, and an update that changes the helper's path or the allowed IDs fixes the manifests at the next launch. It writes a manifest only when its content differs, written whole and then moved into place, as the config is. On Windows the manifests go in `%APPDATA%\WikiStow Desktop\native-messaging\`, with the keys written by `reg.exe`, since the app has no native modules. Clipping needs the app opened and signed in anyway, so a manifest missing before the first launch costs nothing. Decide 3.

**Kept current, and removed.**
- Each launch checks and fixes them. The beta writes its own host name's manifests and never touches the stable app's.
- A Mac app opened where it was unzipped, still marked as downloaded, runs from a random path that macOS later removes (`/AppTranslocation/`). The app writes no manifests from there, and Settings says to move it into Applications.
- **Settings → Browser clipping** turns clipping off on this computer: the app deletes the manifests and keys it wrote, and closes the socket. Turning it on writes them again. It starts on.
- The Windows uninstaller deletes the keys and the folder. The Homebrew cask's `uninstall` deletes the Mac manifests, which aren't the person's data. On Linux, and for a Mac app dragged to the Trash, nothing removes manifests in the person's home folder. They point at a helper that's gone, so the browser fails to start it, and the extension says the app isn't installed.
- A development build writes none unless started with `--clip-manifests`, so it doesn't take the installed app's host name.

**Sandboxed browsers.** Ubuntu's Firefox is a snap. On Ubuntu it reaches native hosts through the WebExtensions desktop portal, a patch Ubuntu carries since 22.04, which starts the host outside the sandbox and asks the person first; Mozilla's page calls it work in progress, to be replaced by a native messaging proxy, with no prompt, which Ubuntu 26.04 has ([Mozilla's design](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/native-messaging-portal-design.html)). The page names no manifest folder, so where the portal looks is for step 2 to find, on Ubuntu 24.04 and 26.04. Firefox as a Flatpak elsewhere may have neither, and then lands in **No host** (decision 7). Chromium browsers as Flatpaks or snaps start hosts inside their sandbox, so they're out of scope (decision 9). So is a managed Chrome whose `NativeMessagingUserLevelHosts` policy is off, which ignores per-user manifests.

### 3. Trust

**Which extensions.** Each manifest names only the published IDs. `allowed_origins` takes exact origins, never wildcards.
- **Chrome, Chromium, Edge and Brave:** `chrome-extension://<Chrome Web Store ID>/`. Edge and Brave install from the Chrome Web Store. The store fixes the ID at the first upload; its public key, put in the development manifest's `key`, gives an unpacked build the same ID, so development needs no other origin. An Edge Add-ons listing would have another ID, and is out of scope.
- **Firefox:** `allowed_extensions: ["web-clipper@wikistow.skint007.github.io"]`, the ID set in `browser_specific_settings.gecko.id`, which a temporary add-on loads under too.

**What stops whom.**
- **Web pages** can't start a host or reach the socket. The extension declares no `externally_connectable` and listens to no `onMessageExternal`. Its content scripts listen to no page messages. Its background takes messages only from its own popup and the content script it injected: `sender.id` must be its own, and `sender.url` says which, since a content script shares the extension's ID ([Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)). A page does choose what's clipped from it: its HTML goes through the paste cleaning, and the reader's sanitizer, like any pasted HTML, and its images come in only as attachments (decision 5).
- **Other extensions** can't start the helper. The browser refuses any extension the manifest doesn't name. In the spike: "Access to the specified native messaging host is forbidden."
- **Other accounts on the computer**, and on Windows other computers, can't read `clip-host.json`, so they can't answer the challenge (decision 1).
- **Programs running as the person** can. They can run the helper with any arguments, or read the token and connect themselves. That is the line `docs/desktop.md` already draws for the keyring: "anything running as you can still ask the keyring for the key". What such a program gains here, without the vault key: making drafts in folders the person can edit, and, by searching again and again while the app is unlocked, every folder's path. Searches are limited to 60 a minute. It can't read a page, publish, delete or move anything.

**What the app checks before saving.**
- The token's challenge (decision 1), then the protocol version (`v`), then the message against a strict schema with size limits (decision 4). It drops the connection on anything else.
- The caller the helper names (the origin, or Firefox's extension ID) is one of the published IDs. This is a check for mistakes, not a defence, since the helper can't prove it.
- The app is signed in, and the person can edit the folder chosen, which the server enforces too. A clip never publishes.
- The page's address is `http:` or `https:`. Others, such as `file:`, go in as text, unlinked.
- The HTML goes through the same cleaning as a paste (decision 5). Images come from `http:`, `https:` or `data:` addresses only, are fetched as decision 5 says, and are checked to be images.
- One clip at a time (another gets `busy`), at most 30 a minute, at most 50 images and 100 MiB of them in one clip, and at most 200 images a minute. Drafts stay well under the server's 120 writes a minute, and images under its 400 uploads a minute (`UPLOAD_LIMIT`, `apps/server/src/routes/content.ts`). The administrator sets the upload limit (`MAX_UPLOAD_MIB`, 25 MiB by default, 1 MiB at the least): a screenshot over it is refused as `too-large`, and an image over it stays a link.

**Approving the first connection.** Bitwarden's desktop app can ask the person to verify a browser by a fingerprint. Here the browser already limits who can start the helper to the published extension, and a program running as the person can claim any origin, so a prompt would stop nobody the manifest doesn't. Instead, each clip shows in the app as it lands, **Saved “Title” to Recipes** with **Open**, and Settings → Browser clipping lists this session's last ten, from memory. Decide 4.

**Main holds the clip in memory.** Main passes each clip to the page and keeps it only until the page takes it. It never writes one to disk. The only thing kept of clips between launches is the IDs of the five folders they last went to, in the page's own settings, never names. This is the first decrypted content main holds, as it held only sealed bytes before, but a clip is what the person chose from a web page, not what's in their vault. Images fetched for a clip pass through main the same way.

### 4. The message format and size limits

Each message is JSON, UTF-8, after its length as a 32-bit unsigned integer in the computer's own byte order. That is the browser's framing, and the helper and app use it on the socket too, so the helper copies bytes without reading them. Chrome documents a message to the host as at most 64 MiB and one from the host as at most 1 MB. Firefox documents 4 GB and 1 MB. Chrome's were checked in Chromium 153 (Spike evidence): a message over 64 MiB throws in the extension before it's sent, and a reply over 1,048,576 bytes ends the port.

Every message has `v: 1`, an `id` of its own, which the answer repeats, and a `type`:

| From the extension | The app's answer |
| --- | --- |
| `hello` `{extension, browser}` | `status` `{app: "closed" \| "starting" \| "signed-out" \| "locked" \| "ready", offline, appVersion, protocols}`, where `protocols` is the lowest and highest `v` the app takes. The helper answers `closed` itself. |
| `open` | The helper starts a closed app. A running app shows its window. Either way, a `status` under the same `id` each time the state changes, until `ready` or the port closes. |
| `folders` `{query}` | `folders` `{recent, matches}`: the five folders clips last went to and at most 50 matches, each `{spaceId, folderId, path}`. Only while unlocked. |
| `clip` (decision 5) | `accepted` `{waits}`, where `waits` is `null`, `"starting"` or `"unlock"`, then `saved` `{spaceId, pageId, title, path, images: {saved, skipped}, faithful}`, or `error` `{code, message}` |
| `show` `{spaceId, pageId}` | Opens that draft in the window, if a clip made it since the app opened: `shown`, or `error` `not-allowed`. |

`error` codes: `version`, with the lowest version the app takes, so one side can say which to update; `invalid`; `too-large`; `signed-out`; `locked`; `no-folder`; `not-allowed`; `busy`; `failed`.

**Limits, below the browser's.** A `clip` is at most 48 MiB as JSON, which leaves the browser's 64 MiB a margin, and the extension refuses a larger one before it's sent: at most 16 MiB of HTML and a 32 MiB screenshot as base64 (24 MiB of image). The title is at most 500 characters, the note 10,000, and at most 20 tags of 100 each. A folder search's query is at most 200 characters. Every answer from the app stays under 64 KiB, far below 1 MB: paths are cut at 200 characters each. Whatever comes in, the Markdown it makes must fit the page's 256 KiB (decision 5).

**Images and screenshots.** A screenshot travels inside the `clip` message, as base64 in JSON. In the spike, a 60 MiB message reached the stand-in app, and its small answer came back, in 238 ms, and 10 MiB in 38 ms. Images in a clip travel as their addresses in the HTML, and the app fetches them (decision 5), so a long article with many pictures stays a small message.

**Where sending happens.** In the extension's service worker, or in Firefox its background script, never the popup. The popup closes when the person clicks into the app to unlock it, and a port the popup held would close with it. A port to a native host keeps a Chrome extension's service worker running (Chrome 105 on, [service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)), and Firefox's background script (Firefox 104 on, [bug 1770696](https://bugzilla.mozilla.org/show_bug.cgi?id=1770696)). The background connects for each clip, status check or search, and disconnects once answered: for a clip, once `saved` or `error` arrives. A clip waiting for the app to start or unlock keeps its port open for up to 10 minutes. Then the extension says **Still waiting in WikiStow** and disconnects; the app keeps the clip, saves it on unlock, and its notice says so. So no helper stays running between clips.

### 5. Clip modes, Markdown and images

The extension captures; the app converts. The extension's content script runs only when the person asks, through `activeTab` and `scripting`, and sends HTML with every address made absolute. It turns each image into the one the page shows (`currentSrc`), and drops what the page hides: elements with no box, or `display: none` or `visibility: hidden` as computed. The live page knows these; the app, reading HTML, doesn't.

| Mode | The extension sends | The page made |
| --- | --- | --- |
| **Link** | The tab's address and title, the person's note, and the selection as text, if any | The note, the selection as a quote, and the link |
| **Selection** | The selection's HTML (`Range.cloneContents`) | Its Markdown |
| **Article** | Mozilla Readability's article HTML, title, byline and site name, run in the content script on a copy of the document | Its Markdown, with `author` from the byline |
| **Whole page** | The body's HTML | Its Markdown |
| **Screenshot** | `tabs.captureVisibleTab` as PNG, or the part the person drags out, cut in the background script | The image as an attachment, with the link below it |

Every page gets the title the person gave it, and the properties `source` (the address, as import writes it) and `clipped` (the date), and `tags`. The context menu's **Send link to WikiStow** and **Send selection to WikiStow**, and a keyboard shortcut (`commands`), send without the popup, to the folder clips last went to. Before there is one, they open the popup.

**Where HTML becomes Markdown.**
- **A. Turndown, in the extension,** as Joplin's clipper does. A small message, but a second converter with its own dialect, to keep in step with the editor's, the reader's and wikilinks' escaping, and each fix waits on two store reviews.
- **B. The app's paste path** (recommended). The page runs the clip's HTML through `unstyled`, the editor's schema and the visual editor's writer, so a clip becomes the Markdown pasting the same HTML would. One converter, fixed with the app. It needs that path made usable without an open editor (step 3). Whatever the schema can't hold goes, as in a paste. Decide 6.

A page longer than 256 KiB of Markdown isn't saved: the extension says it's too long, and suggests Article or Selection.

**Images become attachments.**
- The page asks main for each image the clip's Markdown names, at most 50 of them. Main fetches it with a session of its own that keeps no cookies, with the clipped page's origin, not its whole address, as `Referer`, from `http:` or `https:` only, following at most five redirects, each to `http:` or `https:` too. It refuses loopback, private and link-local addresses, checked after each name lookup and each redirect, unless the clipped page is on one itself, as an intranet page is. So a page can't use a clip to reach the person's local network. An image must say it is one (`image/*`), and be at most the server's upload limit. A `data:` image is decoded the same way, under the same checks.
- Main hands the bytes to the page, which attaches them to the new page with `pageWriter.attach`, then saves the draft with each image pointing at its attachment. That is the order `createFromTemplate` uses. An image that can't be fetched becomes a link to its address, as the page can't show it. One with no address to link, such as `blob:`, becomes its alt text.
- **Why the app fetches.** The extension could fetch with the person's cookies only with host permission for every site, which Chrome's store reviews closely and shows as "Read and change all your data on all websites". The app fetches without the person's cookies, so an image shown only to someone signed in to the site isn't saved. Decide 5.
- The page is made with `newPage`, its images with `attach` and its body with `draft`, the page writer's steps. So a clip made while the WikiStow server doesn't answer waits in the queue with its images, as a page made offline does (ADR 0009). Main still fetches the images from their sites, which may answer; those that don't become links.

### 6. Choosing a folder

The popup shows the folder clips last went to, and a search box. Typing sends `folders` with the query. The app searches the folders this person can edit, in every space, by name and path, and answers at most 50, with the five used last. The popup keeps them only while it's open, and the extension keeps the last folder's ID and path in `storage.session`, which lives in memory and goes when the browser closes. Nothing about the person's folders goes to disk on the browser's side.

- **A. The app sends the whole folder list.** Simplest, but a large wiki's tree may pass the 1 MB limit, and all its names cross for every popup.
- **B. The app opens a picker in its own window.** No names cross, but every clip leaves the browser for the app, and the popup closes.
- **C. Search and the last five** (recommended). Few names cross, only while unlocked, and only for what the person typed. Decide 7.

While the app is locked, the popup offers only the last folder, by the name it kept this session, and saves there once the person unlocks. With no last folder, as after a browser restart, it says **Unlock WikiStow to choose a folder** and sends nothing yet. If, at unlock, the person can no longer edit the folder, the app keeps the clip and asks in its window where to put it. Folder names never leave the app while it's locked, signed out or closed.

### 7. When the app is closed or locked, or missing

| What the extension finds | It says | A clip |
| --- | --- | --- |
| No host: "Specified native messaging host not found", or the helper is gone | **Clipping needs the WikiStow desktop app on this computer**, with a link to installing it. A browser with no native messaging, such as Firefox for Android, gets the same, as do ChromeOS and sandboxed Chromium browsers. | Not sent |
| `closed` | **WikiStow is closed**, with **Open WikiStow** | On **Open**, the background starts the app (decision 1), waits for it, then sends |
| `starting` | **Opening WikiStow…** | Accepted. Main holds it until the page loads and says its state, then it goes as below |
| `signed-out` | **Sign in to WikiStow first** | Not accepted. The popup keeps what the person typed in `storage.session` |
| `locked` | **Switch to WikiStow to unlock** | Accepted. The page holds it in memory, shows **1 clip waits** on the unlock screen, and saves it once unlocked. Closing the app with one waiting asks first, as closing with an unsaved draft does |
| `ready`, `offline: true` | **Offline: saved once WikiStow is back online** | Saved into the queue (decision 5) |
| `ready` | Nothing | Saved |

After a save, the toolbar button shows a check for a few seconds, and the popup, if open, says **Saved to Recipes** with **Open in WikiStow** (`show`). A failure shows `!` on the button, and the popup says why. The extension needs no `notifications` permission.

**A browser-only person,** with no desktop app, gets the first row. The extension can't clip without the app. A `share_target` for the installed web app on Android is a separate issue (#406's notes).

### 8. Store review

**Permissions** ([Chrome's policies](https://developer.chrome.com/docs/webstore/program-policies/policies): "Request access to the narrowest permissions necessary"):
- `nativeMessaging`: the whole point. Chrome warns "Communicate with cooperating native applications", Firefox "Exchange messages with programs other than Firefox".
- `activeTab`: the tab the person clipped from, its address and title, and `tabs.captureVisibleTab`. The toolbar button, the context menu and the shortcut each grant it. Firefox allows `captureVisibleTab` with `activeTab` from version 126. The extension sets `strict_min_version: "140.0"`, the first Firefox with built-in data consent.
- `scripting`: to run the content script in that tab, only when asked.
- `contextMenus`, and `storage` for `storage.session` and the extension's own settings.
- No host permissions, no `tabs`, and no content script that runs on every page. Neither browser lets a content script call native messaging, so the background does.

**One extension for both.** Manifest V3, with `background.service_worker` for Chrome and `background.scripts` for Firefox in one manifest. Chrome ignores `scripts` from version 121, and Firefox, which has no extension service workers, uses it ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)). Readability is bundled, never loaded from a server, as the Chrome Web Store forbids remote code.

**Privacy.** The Chrome Web Store needs a privacy policy from any extension that handles user data, and its Privacy practices form. A page in the repository, `docs/web-clipper-privacy.md`, linked from both listings, says: the extension sends the tab's address and title, and only what the person chose to clip, to the WikiStow desktop app on the same computer, which encrypts it and saves it on the person's own WikiStow server. Nothing goes to WikiStow's developers or anyone else, and there's no analytics. The extension keeps nothing on disk but its settings. The form declares "Website content" and "Web history" and the Limited Use statement. Firefox requires new extensions, from 3 November 2025, to declare `data_collection_permissions`, where transmission means anything handled "outside the add-on or the local browser" ([built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)). Sending to the desktop app leaves the browser, and Mozilla's add-on policies "apply to any data sent to the native application as well" ([policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)). So the extension declares `websiteContent` and `browsingActivity` as required, and Firefox shows that at install.

**Firefox signing.** Every add-on is signed after Mozilla's automated validation, which takes up to 24 hours, and may get a person's review at any time after ([signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)). Built with Vite, it needs its source with each version, which reviewers rebuild and compare file by file ([source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)). The build is unminified, and CI attaches a source zip with the lockfile and a README that builds the same files. Reviewers build on Ubuntu 24.04 on ARM64 with Node 24 and npm unless told otherwise, and WikiStow needs Node 26 and pnpm, so the README says so.

**Accounts and versions.** Both listings need developer accounts that are the user's: the Chrome Web Store charges a registration fee and asks the publisher's trader status. Decide 8. Store versions are numbers only, so the extension has versions of its own, released from WikiStow's tags when it changes, never as a beta. The stores update an extension within days, while the desktop app never updates itself, so the extension is usually the newer. So the protocol carries `v`: the extension speaks every version since 1 until an ADR drops one, and the app accepts its own and the one before.

### 9. Out of scope for the first version

- Safari, an Edge Add-ons listing, and Firefox for Android;
- Chromium browsers as Flatpaks or snaps, and managed browsers that turn off per-user hosts;
- clipping without the desktop app, and a browser extension holding keys;
- full-page screenshots, stitched from scrolling, and clipping PDFs or other files;
- images that need the person's cookies on the site;
- editing the Markdown in the popup, highlights, and adding to an existing page;
- publishing a clip; it is always a draft;
- choosing which account, if the person signs in to several servers; the app clips into the one it's signed in to.

## Spike evidence (2026-11-13)

A throwaway spike (`~/.cache/wikistow-tmp/adr-web-clipper/spike/`, not committed) loaded a Manifest V3 extension unpacked, with a pinned ID, into Chrome for Testing 153.0.8010.12, through Playwright 1.63 under Xvfb, on Arch Linux, an Intel Core Ultra 9 185H. Host manifests went in the profile's `NativeMessagingHosts` folder. Three hosts each relayed to a stand-in for the app, a Node process listening on a Unix socket in a `0700` folder, with a token file of mode `0600`: a Rust relay built with the standard library alone (374 KB), the same relay in Node run by Electron 44.11.2 as Node (`ELECTRON_RUN_AS_NODE=1`, behind a shell script), and in Electron itself, with no window. All calls were made from the service worker. Firefox, Windows and macOS were not tested.

- **It works.** `connectNative` from the service worker started each host. With no app, each answered `closed`. On `open` it started the stand-in in its own process group, waited for its token file and relayed the next message to it, in 40 ms. The stand-in kept running after the port closed.
- **Time and memory per host**, with the stand-in running:

  | Host | First answer, median of 9 | Memory |
  | --- | --- | --- |
  | Rust relay | 6 ms (5–8) | 2 MB |
  | Electron as Node | 61 ms (47–84) | 79 MB |
  | Electron | 133 ms (123–146) | 122 MB |

  A small message's round trip, once connected, took 0.1 to 0.2 ms for each (median of 51). Memory counts only the process running the relay, not Electron's helper processes, so Electron's real totals are higher.
- **Not spiked:** the token's challenge. The stand-in took the token in plain text.
- **Size to the host**, with the Rust relay, the message there and a small answer back, median of 3: 1 MiB 6.7 ms, 10 MiB 38 ms, 30 MiB 106 ms, 60 MiB 238 ms (`results2.json`). An earlier run of the same script, printed but not saved, gave 6, 40, 97 and 183 ms. A message just over 64 MiB threw in the extension, "Message exceeded maximum allowed size of 64MiB.", and nothing was sent. A first run timed 6.9 s for 60 MiB, but its stand-in joined buffers on every read; the times above are after fixing it. The rest of the numbers here are in `results.json`.
- **Size from the host.** A reply of 1,048,559 bytes arrived. One of 1,048,599 ended the port with "Error when communicating with the native messaging host."
- **Refusals.** A host with no manifest: "Specified native messaging host not found." A host whose manifest names another extension: "Access to the specified native messaging host is forbidden."
- **Process groups.** Chromium on Linux ended only the host when the port closed: a stand-in started in the host's own process group was still running 3.5 s later (`results2.json`, and the unsaved run before it). Firefox, by MDN, signals the whole group, which is why the helper starts the app in a new session anyway.

## Considered options

- **The extension holds keys, as an agent** (#406's first plan). Replaced by the issue's decision: it needed an extension origin on the server, `packages/client` in a service worker, and keys kept unencrypted in `chrome.storage`.
- **A local HTTP server in the app,** as Joplin's clipper uses. The spec rules it out, and any page could find the port and send to it.
- **A `wikistow://clip` link,** as some clippers use. No answer comes back, a link is limited in length, and any page can open one.
- **The Electron app, or Electron as Node, as the host** (decision 1). One language, but 10 to 20 times slower to start and 40 to 60 times the memory of a small helper, for every popup, and it can't be the app itself.
- **A helper in Rust** (decision 1, Decide 1).
- **The single-instance handoff, or a file drop, to reach the app** (decision 1).
- **System-wide manifests from the packages** (decision 2).
- **Approving each browser in the app** (decision 3, Decide 4).
- **Turndown in the extension** (decision 5, Decide 6).
- **The extension fetching images,** with host permission for every site (decision 5, Decide 5).
- **Listing every folder, or a picker in the app** (decision 6, Decide 7).

## Consequences

- **Now, with this ADR:** `wikistow.md` line 27 says it's proposed.
- **Once accepted:**
  - `wikistow.md` gains a **Web clipper** section: the modes, drafts, the properties, the folder search, the closed and locked cases, and that the desktop app listens on a socket only the person can open, as line 57 now says.
  - `docs/desktop.md` gains the helper, the manifests the app writes and where, the socket, **Settings → Browser clipping**, and how removal leaves them on Linux.
  - `ui-design.md` gains the popup, and the app's **Saved** notice, its unlock screen's waiting clip and the setting.
  - `CONTEXT.md` gains **Clip** and **Clip host**.
  - The protocol document's trust section gains what a program running as the person can do through the socket.
- **Code:**
  - A new `apps/clipper`: the extension, in TypeScript, built by Vite, unminified, with Readability as a dependency, and its store builds.
  - A new `apps/desktop/clip-host`: the Go helper, with its own tests, built for each package's targets.
  - `apps/desktop/src` gains the socket and token file, the manifests and keys, the image fetcher, the bridge's clip events and `clipState`, and the setting.
  - `packages/ui` gains the clip handler: HTML to Markdown from the paste path without an open editor, the page, its attachments, the notice, and the waiting clip.
  - The Linux packages, the Windows installer and uninstaller, the Mac app and the Homebrew cask carry the helper, and the cask's `uninstall` the manifests.
  - CI builds the extension, lints it with Mozilla's `web-ext lint`, and attaches its source zip to releases. The release uploads it to both stores.

## Implementation, in pull requests

1. **This ADR.**
2. **The helper and the socket.** The Go helper, built for every target from Linux and tested with a fake app, and in every package: the release archive and both PKGBUILDs, the `.deb` and `.rpm`, the Windows installer (whose wait for the app to close covers the helper too) and uninstaller, the Mac app and the cask. The app's socket or pipe, `clip-host.json` and the token's challenge, the manifests and keys at launch, and **Settings → Browser clipping**. A desktop e2e on Linux that loads a test extension into Chromium and reaches the app through the helper. Checked by hand: on Windows 11 with Chrome and Firefox, the helper starting the app from inside their jobs, a pipe read and written at once, and the pipe from a second account and another computer, and bringing the window forward; on a Mac with Chrome and Firefox, that Gatekeeper lets the browsers start the ad hoc signed helper; on Ubuntu 24.04 and 26.04, Firefox's snap through the portal or the proxy, and where each looks for manifests; and bringing the window forward on GNOME under Wayland.
3. **HTML to Markdown without an editor.** The paste path, `unstyled` through the schema and the writer, made a function of its own in `packages/ui`, with tests that a clip and a paste of the same HTML give the same Markdown.
4. **The clip in the app** (built, PR #447). The bridge's events, the page made with the page writer, the properties, the image fetcher in main and the attachments, the locked and offline cases, the notice, the folder search and the rate limit. Decided while building it:
   - **A clip never fills Properties from frontmatter-like text** in what it clipped, as `htmlMarkdown` doesn't and an empty page's paste of a note does: a website shouldn't set a page's properties. The clip's own properties come first in the page, so whatever the site wrote is its body.
   - **A clip whose Markdown reads back otherwise** than the paste showed (`faithful` false) is saved as written, as the editor keeps such a paste and shows it in source mode. The notice says to check the draft, and `saved` carries `faithful` for the extension to say so too. Keeping the site's HTML as an HTML block instead would put the site's markup in the page, often past 256 KiB.
   - **Main keeps a clip until the page says how saving it went,** not only until the page takes it, so a reload, a crash or a lock partway loses nothing. It's still memory only. Once the page is made, the page tells main (`clipMade`), so a page that loads again with the clip held finishes it as saved rather than making a second; its images are then links.
   - **The page's receiver is on every page,** at the router's root, so main always hears whether the vault is open, even on the sign-in or an error page.
   - **Offline, a clip to a space this computer doesn't keep** is saved into the queue as it was sent, as its folders can't be checked here; the server checks them once it's sent, and the notice names no folder.
   - **The page is made with its text first** (`newPageDraft`), its images as links to their sites, then each image is attached and the text saved again pointing at them. A clip cut short keeps its text; with no image saved, there's no second version.
   - **Images are PNG, JPEG, GIF, WebP, AVIF, BMP or ICO,** told by their bytes, whatever the server says. Not SVG: a site's SVG can hold scripts. Each is at most 24 MiB, under the server's default upload limit with room to seal it; one the server refuses as too large stays a link. A `data:` image the clip couldn't save, or a `blob:` one, is its alt text, as is any image inside a link's text.
   - **The local network** counts loopback, private (with shared address space, `100.64.0.0/10`) and link-local addresses, IPv4 or IPv6, and IPv4 inside IPv6 (mapped, NAT64 and 6to4). Unspecified, multicast, reserved and documentation addresses are never fetched. A page is on the local network when its address is a local one, or its name is one nobody outside the network answers for (a single label, or under `.local`, `.localhost`, `.internal`, `.lan` or `.home.arpa`) and all its addresses are local; it lets in images from its own kind of address only. Any other name's records are the site's to choose: it could name a local address beside its own, or switch to one between the browser's lookup and the app's. So an intranet under a public domain, such as `wiki.example.com` on `10.0.0.5`, gets its images as links. No proxy is used.
   - **A clip's images are fetched one at a time,** within two minutes of the first in all, so a slow site can't hold the one clip past the extension's wait.
   - **`show` opens only a draft a clip made since the app opened,** so a program running as the person can't use it to open other pages by ID.
   - **One clip at a time,** waiting ones included: another gets `busy` until the first is saved or fails. Signing out, or signing in again, fails the clips held, as `signed-out`, and the page saves only a clip main still holds.
5. **The extension** (built, PR #PRNUM). `web-ext lint` in CI. Link, Selection, Article and Whole page modes, the popup, the context menu and the shortcut, the closed, locked and missing cases, with tests in Chromium against a fake host. The privacy page (`docs/web-clipper-privacy.md`). Decided while building it:
   - **Two builds, two manifests,** from the same scripts (`apps/clipper/src/manifest.ts`): Chrome's names a service worker, Firefox's a background script, its ID, its data consent and `gecko_android` (Firefox for Android only says clipping needs the desktop app). The Firefox ID is a build setting, `CLIPPER_FIREFOX_ID`, a repository variable in CI; until step 7 sets it, builds name `web-clipper-dev@wikistow.invalid`, which no app trusts. Neither store build has a `key`; only the tests' build has one, and host permission for `http://127.0.0.1/*`, to clip from the tests' site without the toolbar's click.
   - **The content script answers as its injection's result,** never by message, so the background listens to no message at all: only its own popup's port (`runtime.onConnect`, checked by `sender.id` and the popup's address).
   - **What a page hides** is read from the live page as the copy is cleaned: an element with `display: none`, or no box (save `<br>`, `<wbr>` and `display: contents`), goes; under `visibility: hidden`, its own text and images go, but what's shown again in it stays. An image takes `currentSrc`, without `srcset`, and its `<picture>`'s sources go. A selection keeps the `pre`, `code`, `a`, `blockquote` and heading it lies in. Article runs Readability on a copy made of what's shown, which, as Firefox's Reader View, makes the article's `h1` an `h2`.
   - **The popup** chooses Selection when text is selected, else Article, and offers only Link where no script may run (the browser's own pages). Tags are typed separated by commas. **Which WikiStow app**, under the form, pins the stable app or the beta, kept in `storage.local`, the only thing kept on disk. While the app is starting, locked or signed out, the popup asks again every 2 s.
   - **A closed app** gets `open` and the clip on one port, which the helper holds the clip behind until the app listens; Save does this with a folder kept from earlier in the session, and so do the context menu and the shortcut. Without one, the popup offers **Open WikiStow**.
   - **The context menu** offers **Send link to WikiStow** on a page and **Send selection to WikiStow** on a selection. **Alt+Shift+W** opens the popup, and **Alt+Shift+S** sends the selection, or else the link. Without a folder this session, they open the popup; Firefox opens it only while handling the click or key, so it's asked at once when the session has none.
   - **The last folder** is the one a clip went to, remembered only when the app saved it there, not where the person chose instead at the unlock.
   - **One clip at a time** from the extension too, while one is on its way or waits.
   - **The extension's version** is its own, from 0.1.0, outside `scripts/version.ts`; each WikiStow release carries its two zips.
6. **Screenshots,** visible and chosen part.
7. **Store listings.** The developer accounts, the store builds, the Firefox source zip in releases, and the first submissions.
8. **The spec,** marked built.

Step 3 can run beside step 2. Step 4 needs both, step 5 needs step 4, and step 6 needs step 5.

## Decided (2026-11-13)

Scott accepted every recommendation below on 2026-11-13: the helper in Go; the socket or named pipe behind a token, with `wikistow.md` line 57 reworded from "runs no local server" to "opens no network port" and naming this listener; and the Firefox ID `web-clipper@wikistow.skint007.github.io`. He opens the Chrome Web Store and Mozilla Add-ons accounts, so publishing waits on them, not the build.

1. **A small separate helper, in Go?** Recommended: yes (decision 1). It answers in milliseconds with a few megabytes, where Electron takes 60 to 130 ms and 80 to 120 MB for every popup, and it can't be the app anyway. Go builds every target from Linux, so the Windows helpers join the installers where they're built, with `go-winio` for the pipe. Rust is the choice if the second compiled language should be the one the spike used: its Mac helpers build on the Mac runners, as the app does, and Windows needs a cross linker or Windows runners.
2. **The running app listens on a Unix socket in a folder only the person can open, or a Windows named pipe, behind a token in a file only they can read?** Recommended: yes (decision 1). The app opens no network port of its own, and no page can reach it. On Windows another account, or another computer through file sharing, can open the pipe to read, but can't send, and can't answer the token's challenge. It is still a listener the app didn't have, which is why it's here for you to confirm against "runs no local server".
3. **Per-user manifests written at each launch, with Browser clipping on by default and an off switch?** The issue decided the app installs them for each browser it finds. Recommended: yes (decision 2): writing them at launch, rather than from the packages, keeps one way on every system, current at every launch. The cost: on Linux, and for a Mac app dragged to the Trash, manifests stay behind after the app is removed, pointing at nothing.
4. **No approval prompt, but a notice in the app for each clip?** Recommended: yes (decision 3). The browser already lets only the published extension start the helper, and a prompt can't tell a program running as you from your browser.
5. **The app fetches images without the person's cookies, and the extension asks for no host permissions?** Recommended: yes (decision 5). The extension installs with no "all your data on all websites" warning and an easier review, at the cost of images shown only to people signed in to a site.
6. **HTML becomes Markdown in the app, through the paste path, not Turndown in the extension?** Recommended: yes (decision 5). One converter, written in the editor's own style and fixed with the app, not waiting on store reviews.
7. **Folders by search, at most 50 per answer, only while unlocked?** Recommended: yes (decision 6). A large wiki's tree never has to fit 1 MB, and few names cross.
8. **Whose developer accounts, and the Firefox ID `web-clipper@wikistow.skint007.github.io`?** The Chrome Web Store account and fee, and the Mozilla Add-ons account, are yours to open. The Firefox ID can't change once listed.
