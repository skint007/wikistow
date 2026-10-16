---
status: built
---

# A plugin library on the server, and plugins in the browser

WikiStow's server gains a shared plugin library (#5). Members upload built plugins, and anyone on the server can install them, in the browser, on a phone or in the desktop app. Installing is approving the plugin's hash; the approvals live in the person's encrypted, signed account data, so they follow the person to every device and the server can't add one. The browser runs approved plugins from the server's own origin, a script's code in a worker inside a sandboxed frame with an opaque origin, so it can't reach the tab's storage.

This amends [ADR 0001](0001-desktop-plugin-runtime.md), whose rule was that the server never supplies plugin code, because "a server that could push code could read every page". That still holds where it mattered: the desktop app installs only hashes the person approved and checks the files against them, so the server can't push it code. The browser already runs whatever code the server sends, the web app itself included ([spec, What the service can see](../../wikistow.md#what-the-service-can-see)), so serving plugin files there gives the server no new power. A shared plugin can still be malicious, as in any plugin system; the answer is to install only plugins you trust, and the approval dialog keeps naming the trust level. App plugins stay unsandboxed.

## What changes in ADR 0001

- Plugins can come from the server's library as well as from a folder. Folder installs and development loading stay, on the desktop only.
- Approvals of library plugins, with their page access and on/off state, are kept per account and follow the person. Folder and development installs stay per device.
- In the browser and on the desktop, a script's worker runs in a sandboxed frame, not on the app's origin. Its consequence about needing "an origin of its own" is met by an opaque origin, not a `wikistow-plugin:` scheme.
- The app's CSP gains `frame-src 'self'`. Nothing else in it changes.

## Decisions

### The library

- **Upload.** Any member (not agents) uploads a built plugin folder: on the desktop from an installed plugin or a workshop version, in a computer's browser by choosing its folder. The server reads it as the desktop reads a folder today: it validates the manifest with the SDK's schema, refuses links and unsafe paths, and hashes it the same way (SHA-256 over each sorted path, length and contents; the hashing moves to the SDK so the server and desktop share it). A version is at most 10 MB and 500 files, and its `script` at most 1 MB (Chromium won't start a `data:` worker over 2 MB). Uploads count as expensive mutations for rate limiting.
- **Ownership.** The first account to upload an ID owns it; only that account uploads more versions of it. It keeps the ID when every version is removed, so another account's plugin can never arrive as an update of one people approved. The owner removes a version or the whole plugin; an admin can remove any. Nothing else changes a stored version: files are stored by hash, like attachments' blobs (outside Postgres, in the backups), with a row per plugin (ID, owner) and per version (hash, manifest, size, uploader, time).
- **List.** Every signed-in account sees the library: each plugin's name, description, trust level, the most page access it may ask for, its owner, its versions and their hashes. Plugin files and manifests are plain text on the server, which has to serve them; the operator can read them.
- **Removal.** Removing a version deletes its files. A browser that approved it stops loading it and says it is no longer in the library; a desktop keeps the copy it installed. The server can't know who approved what.

### Approvals

- **Where.** In the private part of the account's contacts record, under `extensions['wikistow.plugins']`: per library plugin, its approved hash, whether it is on, and its plugin access (spaces or folders, each read or write). That part is sealed to the owner alone (agents can't read it), the record is signed by the person's identity key and chained by `prevHash`, and writes are compare-and-swap with replay on `stale-head`, so two devices' changes merge or report a conflict. No new server record is needed.
- **Sync.** A device reads the record when the vault unlocks, as it does now, so an approval made elsewhere applies at the next unlock. The server can't add or change an approval; withholding the newest record could at most bring back one the person once made.
- **Install** is the approval dialog of ADR 0001 (name, version, trust level, most page access, hash), then writing the record. **Update:** a newer version under the same ID shows as an update; approving it, with any change of level or access shown, replaces the hash. The old version runs until then, on every device. Every changed hash approves again. **Remove** drops the entry, everywhere; pages keep its blocks and `plugin.<id>` data.

### Serving

- `GET /plugins/<id>/<hash>/<path>` serves a library file to any signed-in session, with `Content-Security-Policy: default-src 'none'` (as the desktop does), `nosniff`, the type from its extension, and `Cache-Control: private, max-age=31536000, immutable`, since a hash's files never change. The desktop's own `app://wikistow/plugins/…` keeps serving its local copies.
- The browser loads `ui.js` with `import()`, styles with `<link>`, and a script through the frame below, all from that route. It doesn't hash what it loads: it trusts the server for plugin files as it does for the app's own code. The desktop checks every download against the approved hash before it copies it in.

### The script sandbox: an opaque frame holding the workers

- The app adds one hidden `<iframe sandbox="allow-scripts" src="/plugin-host.html">` while scripts run. The sandbox gives it an opaque origin (`null`): no IndexedDB, Cache Storage, localStorage, sessionStorage or cookies, no access to the app's document, and no navigating the tab.
- `plugin-host.html` and `plugin-host.js` are part of the web build and run only host code. The document is served with `Content-Security-Policy: default-src 'none'; script-src <origin>/plugin-host.js; worker-src data:; frame-ancestors 'self'; sandbox allow-scripts` and no `X-Frame-Options`; its script with `Cross-Origin-Resource-Policy: cross-origin`, since the app's usual `same-origin` blocks it from an opaque origin. Naming the one script, not `'self'`, matters: a worker inherits this policy, and with `'self'` its `import()` and a nested worker's `importScripts` still reached the server.
- For each script the app fetches `script.js` from the library route and hands its text to the frame, which starts it as `new Worker('data:text/javascript;base64,…', { type: 'module', name: <plugin ID> })`. Module workers from `blob:` URLs fail in Chromium in an opaque frame, and from the server's URL in every browser; `data:` works in all three. The worker inherits the frame's policy: no requests, imports or WebSockets.
- The frame relays messages between each worker and a `MessagePort` the app gave it, so the protocol of ADR 0001 is unchanged, already built plugins run as they are (except `host.pluginId`: the SDK read it from the worker's address, which a `data:` worker doesn't have, so it now falls back to the worker's name, and a script built before that reads it empty in the frame until built again), and `ScriptWorker` drives a port where it drove a `Worker`, with the same checks, budgets, restarts and three-failure stop. Ending a script asks the frame to terminate its worker, which happens at once: plugin code never runs on the frame's own thread, because in Firefox and WebKit that thread is the tab's, and a loop there freezes the app. If the frame ever stopped answering, the app removes it, which ends all its workers, and makes a new one.
- Scripts have none of the app's storage, so nothing needs emptying at lock. (WebKit gives the worker an empty Cache Storage of its own, at its opaque origin; Chromium and Firefox refuse it.)
- The desktop app runs scripts through the same frame. Main serves `plugin-host.html` and its script under `app://wikistow` with the same headers, the page's policy naming `app://wikistow/plugin-host.js`, and the app fetches each script from main's own `/plugins/` route, whichever kind of install it comes from: a folder, a library copy, a development folder or a workshop version. Chromium accepts the custom scheme in `script-src` and `frame-ancestors 'self'`, and starts the `data:` worker there. The runtime no longer empties IndexedDB and Cache Storage at lock and start, as it did while scripts were workers of the app's origin.

### Desktop, phones, safe mode

- **Desktop** shows the library in Settings → Plugins. Approving there writes the account record like anywhere else. At unlock, main downloads each approved library plugin it lacks (through its session), checks the files against the approved hash, and copies them into `userData/library-plugins/<id>/<hash>/` as a folder install is copied (beside `userData/plugins/`, not in it, so removing a folder install and deleting library copies never touch each other's files); it deletes library copies no longer approved. A folder or development install of the same ID replaces the library's on that computer until it is removed.
- **Phones** install from the library, which needs no folder, and run plugins as any browser does; every region already shows at phone sizes. Uploading needs a computer.
- **Safe mode in the browser** is per tab: `?safe-mode` in the address, **Open without plugins** on the unlock page, or Ctrl+Shift+Alt+P, then the desktop's banner with **Manage plugins** and **Turn plugins back on**. Plugins load only after unlock (their approvals are encrypted), so the unlock page never runs one. A browser can't see its tab crash, so there is no automatic safe mode there.

### Out of scope

Plugins from other servers, search or ratings, signing by authors, updates without approval, per-device on/off for library plugins, private library entries, uploading from a phone, development loading or the workshop in the browser, storage for plugins, and sandboxing app plugins.

## Spike evidence (2026-10-15)

Playwright's Chromium 153, Firefox 155 and WebKit 26.6, against a test server sending the app's real headers (`frame-src` aside):

| Question | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Frame under today's CSP (`frame-src 'none'`) | refused | refused | refused |
| Frame with `frame-src 'self'`; its host script with CORP `same-origin` | loads, origin `null`; script blocked | same | same |
| Module worker in the frame from the server's URL / `blob:` / `data:` | no / no / yes (up to 2 MB) | no / yes / yes | no / yes / yes |
| IndexedDB, Cache Storage, local and session storage, cookies, parent document, top navigation, from frame or worker | all refused | all refused | all refused |
| App's `BroadcastChannel` hears the frame or worker | no | no | no |
| Requests reaching the server, frame policy naming only the host script | none | none | none |
| Same, with `script-src 'self'` | `import()`, nested `importScripts` | same | none |
| Session cookie sent from the opaque origin when a policy allows requests (`SameSite=Lax`) | no | no | **yes** |
| Worker in an endless loop: longest stall of the app's 10 ms timer | 11 ms | 20 ms | 13 ms |
| Frame terminates that worker; a new one answers | at once; yes | at once; yes | at once; yes |
| Removing the frame ends a busy worker in it | yes | yes | yes |
| The frame's own thread in an endless loop | own process: tab unaffected, a new frame answers 35 ms after removal | **tab frozen** | **tab frozen** |
| Messages through a `MessagePort` handed via the frame to the worker | work | work | work |

WebKit sending the session cookie means the frame's `default-src 'none'` is the network boundary, not the opaque origin; the server also refuses writes whose `Origin` is `null`. The frozen tabs mean plugin code must stay off the frame's thread.

## Considered options

- **A plugin subdomain** (`plugins.example.com`). It is the same site as the app, so `SameSite` cookies still go with its requests and Chromium may share the app's process; real separation needs a second registrable domain, DNS and TLS from every operator. The opaque frame needs none.
- **A `data:` worker started by the app's page itself.** It gets an opaque origin too, but inherits the app's CSP, so it can reach the app's server (WebKit with the session cookie), and the app's CSP would need `worker-src data:`.
- **Running scripts on the frame's thread.** Simpler, but a loop freezes the tab in Firefox and WebKit, and probably on Android, where Chromium gives fewer sites a process of their own.
- **Checking hashes in the browser.** `<script integrity>` before `import()` works only when the first load succeeds (Firefox and WebKit fetch again, unchecked, after a failure), and it can't protect against a server that serves the app's own code.
- **A new encrypted record for approvals.** The contacts record already has an owner-only part with room for extensions, a signature, a version chain and conflict handling.

## Consequences

- The web build and the server gain a host page with its own headers, and the security header middleware lets that route skip `X-Frame-Options` and the usual CORP, as it already lets responses keep their own CSP.
- Plugin access and on/off for library plugins move from the desktop's `plugins.json` to the account record; folder and development installs keep `plugins.json`.
- The library's files are plain text on the server and in its backups.
- Browser checks belong in `apps/web/e2e`: a script can't open IndexedDB or reach the server, and a script in a loop is stopped while the page keeps answering.

## Decided (2026-10-15)

Scott approved every recommendation:

1. The sandbox is an opaque frame holding `data:` module workers, not a plugin subdomain.
2. The desktop runs scripts through the same frame, so there is one path and nothing to empty at lock, checked under `app://` in its own PR.
3. Any member uploads, the first uploader owns an ID, and the owner or an admin removes.
4. Limits are 10 MB and 500 files per version, and `script` at most 1 MB.
5. Approvals live in the contacts record's owner-only part.
6. Library plugins' on or off and their access are per account, with the desktop installing approved ones at unlock.
7. The browser trusts the server for plugin files as for the app's code, without hashing them; the desktop always checks.

## Implementation, in pull requests

1. **Library on the server:** the shared hashing in the SDK, tables and blob storage, upload, list and remove with ownership and limits, the `/plugins/<id>/<hash>/…` route and its headers. Integration tests.
2. **Approvals:** `wikistow.plugins` in the contacts record's private part, and client operations to approve, update, change access, turn on or off and remove, merging on `stale-head`.
3. **The sandbox:** `plugin-host.html` and its script, `frame-src 'self'`, the middleware exceptions, `ScriptWorker` over a port. Browser e2e for isolation and stopping a loop.
4. **Plugins in the browser:** a library `RuntimeSource` for the runtime, Settings → Plugins with the library, approval dialog, updates and removal, upload from a folder, safe mode in the browser, checked on a phone-sized screen. Spec and this ADR's status updated.
5. **Desktop and the library:** listing and approving there, installing approved plugins at unlock with the hash check, sharing an installed plugin or workshop version to the library.
6. **Desktop scripts through the frame,** dropping the storage emptying at lock.

1, 2 and 3 are independent; 4 needs all three; 5 needs 1 and 2.

Status (2026-10-16): built, 1 to 6.
