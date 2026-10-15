---
status: accepted
---

# Desktop plugins: locally installed folders, trusted app code, sandboxed scripts

[ADR 0002](0002-plugin-library-and-browser-plugins.md) (proposed) amends this one: a plugin library on the server, approvals that follow the account, and plugins in the browser, with scripts in a sandboxed frame.

WikiStow gains TypeScript plugins (#256), on the desktop app first. A person installs a built plugin folder from their own disk; nothing comes from the server. The plugin is served from the app's own origin. Its interface code runs in the page with the person's full trust, and its scripts run in a network-less worker that can reach pages only through a typed, access-checked host interface. Pages never carry code: a plugin block in a page is a fenced code block that names an installed plugin, so without the plugin it reads, edits, saves and exports as the code block it is.

This design was accepted on 2026-10-13, with plugin writes as the person's own, moves within existing permissions, three trust levels, folder installs only, plugin data published like any namespace, and no "not responding" prompt. It replaces the spec's earlier rule ("plugin code ships with the application or is approved by an administrator"). The family-and-friends trust model makes a person's own device the right place to decide what runs, and a server that could push code could read every page.

## Decisions

### SDK, manifest, build

- **Package:** `@wikistow/plugin-sdk` (`packages/plugin-sdk`), types plus a small runtime, with entries `.` (`definePlugin`, `defineScript`, manifest types), `./react` (`reactView`, mounting a React component with the plugin's own React) and a `wikistow-plugin build` command. The SDK holds the manifest schema and the worker protocol schema; the desktop app and `packages/ui` import them from there, so there is one definition.
- **Build output** is a folder: `wikistow-plugin.json`, `ui.js` and `script.js` as single self-contained ES modules (no chunks, no remote or bare imports), CSS files and `assets/`. One file per entry keeps the reviewed artifact easy to hash and serve.
- **Manifest:**

  ```json
  {
    "id": "calculator",
    "name": "Calculator",
    "version": "0.1.0",
    "api": 1,
    "description": "Fields and totals in a page",
    "ui": "ui.js",
    "script": "script.js",
    "styles": ["calculator.css"],
    "themes": [{ "id": "dusk", "name": "Dusk", "base": "dark", "stylesheet": "dusk.css" }],
    "access": "write",
    "blocks": ["product"]
  }
  ```

  `id` is `[a-z][a-z0-9-]{1,39}` and names the plugin's data (`plugin.<id>`), commands (`plugin.<id>.<command>`) and blocks (`plugin:<id>/<block>`). Every file field is optional except `id`, `name`, `version` and `api`. `access` is the most page access the plugin may ever be given (`none`, `read` or `write`). `blocks` lists the fenced block types it claims, so the host knows a block's owner before any code runs.
- **Versioning:** `api` is the host interface's major version; the host loads only majors it supports (1). Additions within a major are additive, and a call the host lacks fails with `unsupported`. `version` is the plugin's own and only labels it; approval binds to the files' hash.

### Installing and loading (desktop)

- **Install** picks a built plugin folder in a native dialog in the main process. Main validates the manifest, copies the folder into a staging area, hashes the copy (SHA-256 over sorted paths and contents), and shows the approval dialog. On approval the copy moves to `userData/plugins/<id>/<hash>/`, which is never changed, so what runs is exactly what was approved, whatever happens to the folder it came from. State (installed versions, approved hash and access, enabled, per-account page access) is kept in `userData/plugins.json`, which holds IDs only, never content.
- **Development loading** points at a folder that is read again on each **Reload**, labelled "Development" everywhere it shows. Approval covers the folder, not a hash; asking for more access than approved asks again. The workshop (#257) serves its versions through the same handler and runs them in a runtime of its own.
- **Serving:** main's existing `app://wikistow` handler serves `/plugins/<id>/<key>/<file>` (`key` is the hash, or `dev-<n>` per reload) with the same path checks as the app's files, the right MIME types and `nosniff`. Being same-origin, the app's CSP already allows these scripts, styles, fonts, images and workers. **The app's CSP doesn't change.** Every plugin file is served with its own `Content-Security-Policy: default-src 'none'`, which a worker takes from its response: no `fetch`, WebSocket, `importScripts`, `import()` or nested workers. Ordinary Markdown still can't run scripts, and nothing may load remote code, styles or assets (`'self'` throughout), so a theme can't reach the network either.
- **Loading** in the renderer: `import()` of `ui.js` (a new key per version or reload, so the module cache never serves old code), `<link rel="stylesheet">` per style and active theme, and `new Worker(script.js, { type: 'module' })`. The browser loads no plugins yet. It shows plugin blocks as their code blocks.

### Trust levels

The approval dialog names a plugin's level, which comes from its files:

| Level | Has | Runs | What is real |
| --- | --- | --- | --- |
| **Theme** | styles and themes only | CSS in the app's page | No code. It can restyle or hide anything and can't load remote assets (CSP). It gets no page access. |
| **Script** | `script` (and styles) | a dedicated worker per plugin | Isolated: no DOM, network, cookies or app memory. It can use the origin's IndexedDB and Cache Storage, shared with other scripts, which the app empties whenever the vault locks and as plugins start. It reaches pages only through host messages, each validated and checked against its page access and the person's current access. Its work is time-bounded. |
| **App** | `ui` | the app's page, in-process | **Not isolated.** Same trust as WikiStow's own code: it can read whatever the window shows and call the server as the person. Its host calls are still checked against its page access, but that guards honest mistakes, not a hostile plugin. The dialog says so. |

A plugin's level is its highest part. Credentials, vault keys, the `ClientContext` and the internal registries are never handed to any plugin; an app plugin could still reach what any code in the page can, and the spec says so.

**Page scripts** are not a separate kind of code. A page can only name a plugin (a claimed block); its code always comes from an installation on this device. Opening a shared page whose plugin isn't installed and enabled shows the block's source and a "needs plugin *id*" note, and runs nothing. A formula in a block is data the plugin interprets in its own script.

### Host interface

Plugins get a `host` object, the same shape in `ui.js` and `script.js` (in the worker it is a message proxy):

- `host.pages`: `read(page)`, `list(folder)`, `search(text)`, `create(folder, { title, markdown, data? })`, `createFolder(parent, name)`, `saveDraft(page, { base, title?, markdown?, data? })`, `move(node, parent)`, taking `{ spaceId, pageId }`, `{ spaceId, folderId }` (null for the top of a space) and `{ spaceId, id }`. Results are plain typed data (`{ spaceId, pageId, folderId, title, markdown, revision, version: 'draft' | 'published', data }`), never client objects. `data` is the page's `plugin.<id>` namespace.
- `host.commands.register`, `host.events.on`, `host.blocks.register`, `host.ui.register` (app only), each returning a disposer and also dropped on unload.
- `host.signal`, an `AbortSignal` aborted on unload, vault lock and sign-out.

**Page access** is set per plugin and account in Settings → Plugins: a list of spaces or folders (with descendants), each `read` or `write`, capped by the manifest's `access`. `read` reads what the person can read there (drafts only where the person is an editor; a reader's app can't open drafts, so no plugin can). `write` adds `saveDraft`, `create`, `createFolder` and `move`. Access is ongoing: no prompt per call or keystroke. Every call is checked against the current settings and then runs the existing client operation, so the person's current permissions, the server's checks and payload limits all still apply. `move` is the existing move operation, for a page or folder whose current place and destination both have `write` access, and only where no keys change: a move across a share boundary changes who can read, which the person reviews in the app, so a plugin's is refused (`forbidden`). Publishing, unpublishing, sharing, deleting and access changes are not in the interface.

**Revisions and conflicts:** `saveDraft` needs `base`, the revision the plugin read, and is the ordinary `saveDraft` operation: a newer head fails with `conflict`, never merged or retried by the host. Writes are the person's revisions, attributed to the person.

**The page in front of the person** needs no access setting. A command run from a page, and a block on it, get a handle to that page: `read()` gives the version shown, and in the draft view `edit(change)` (commands) or `setSource(text)` (blocks, their own fence only) change the editor's document as a person's edit would, so the open draft autosaves it with no second writer and no conflict. A `saveDraft` to a page open in this window's draft view goes the same way: what is typed is saved first, a `base` older than that is a `conflict`, and the change is then the editor's next save, so the person's editor never falls behind a plugin's write.

**Errors** are `PluginError` with a code: `not-granted`, `forbidden`, `not-found`, `conflict`, `too-large`, `locked`, `rate-limited`, `timeout`, `unloaded`, `unsupported`, `invalid`, and `failed` for anything else, such as a script's command throwing.

### Rich UI

An app plugin's views are DOM mounts: `mount(element, props) => cleanup`, where `props` is the view's typed plugin-facing data (the page handle, block source, region name), never internal React props. `reactView(Component)` from the SDK mounts a React root with the plugin's own React. Plugins don't share the app's React instance or components; they style with the published theme tokens (CSS variables) and documented `data-region` attributes. A mount that throws shows "*Plugin* failed here" in its place, with **Disable**; a React view that fails later shows the SDK's own short note there instead, and the plugin is turned off in Settings → Plugins or safe mode.

### Registrations

All are made at activation or later, return a disposer, and are removed on unload. Contributions to one region show in plugin order, then registration order; nothing replaces a host region.

- **Commands:** `{ id, title, run({ page }) }`, listed in the page toolbar's Plugins menu and run on the page shown. Plugins can't run the app's own commands.
- **Events:** `page.shown` and `draft.saved` (this app's saves), each with the page reference. A plugin's handler runs one at a time per event and page; events that arrive meanwhile collapse to the latest. Saves made by the plugin itself aren't delivered back to it, including the save its page handle's read makes of what is typed (in the draft view), so a view that reads again on `draft.saved` can't keep the editor saving (#259). A plugin's host writes are limited to 30 a minute, which bounds loops between plugins.
- **Blocks** (reader renderer and visual-editor node in one): a fence whose info string is `plugin:<id>/<block>`. The host's reader and visual editor hand claimed fences to the plugin's block: an app plugin's `view` (mounted with `{ source, page, setSource }`, where `setSource` is null in the reader; built in #256), or a form the host draws from a script's declared fields, with outputs each calculated in the script's worker (built in #260: `host.blocks.register({ type, fields, outputs })`, where each output has its own `calculate(values)` and may read other outputs; one calculation runs at a time per script, and the form keeps only the latest values waiting). A view's own `setSource` doesn't draw it again, so typing in it keeps its focus; a change to the text from elsewhere (source mode, undo) does. Reader inputs stay in the view; only `setSource` in the draft view changes the page. With no plugin, the fence is ordinary fenced code everywhere.
- **UI regions** (app plugins): `rail` (a navigation item opening one of the plugin's `app.view`s), `app.view` (a plugin page in the main area), `page.toolbar`, `page.panel` (a sheet, like History), `page.header`, `page.footer`, `page.aside`, `settings.section`. Layout beyond these is CSS against `data-region` attributes on the shell, the space sidebar, the page card and its parts, and Settings; a plugin replaces something of the app's by hiding it there and adding its own. Every region shows at every size: on a phone the rail's items are in the navigation drawer and a page's asides go below it. #256 built `page.panel`; #259 added the others.
- **Styles and themes** come from the manifest. `styles` load while the plugin is enabled. A `themes` entry adds a choice to the theme picker, which can preview it first. The chosen plugin theme is kept on this device and drawn over its `base` palette (Light or Midnight slate); the account's built-in choice stays the fallback, here while the plugin is off and on every other device. A preview ranks above a chosen theme, which ranks above the account's palette; a plugin theme doesn't follow the system's light or dark setting. Its `<link>` is added last and removed when another theme is shown. The fonts, radii and spacing are CSS variables the app's utilities read (#259 moved them out of Tailwind's `@theme inline`), so a theme sets every token the same way. The SDK lists the tokens as `ThemeToken`.

### Lifecycle

- **Enable** loads styles at once. While the vault is open it imports `ui.js` and calls its `activate(host)`, and starts the script, whose `activate` registers what it handles; unlocking does it again. **Disable** aborts `host.signal`, runs disposers, removes registrations and links, terminates the worker, and rejects pending calls with `unloaded`; results arriving later are dropped by generation. An app plugin's module stays in memory, inert unless it ignored `host.signal` (timers it never cleared); restarting clears that.
- **Update** installs the new folder beside the old one and asks for approval again, showing changed access and level; the old version runs until then. Every changed hash re-approves.
- **Remove** unloads, deletes its folders and its access settings. Its blocks and `plugin.<id>` page data stay in pages.
- Vault lock and sign-out terminate script workers and abort `host.signal`.

### Failure bounds and recovery

- **Scripts:** a command or event gets 10 s and a block's calculation 1 s, wall time from request to answer (a calculation's starts when the worker is sent it, after the one before). Its activation gets 10 s too. Overrunning terminates the worker (its pending calls fail with `timeout`) and starts it again at once. Three failures within five minutes stop the script until the person turns it back on or unlocks the vault again. A malformed message counts as a failure. Normal editing never waits on a script.
- **App plugins** throw inside error boundaries and `try`, shown per plugin. A plugin that freezes or hides the app is handled by **safe mode**, which loads no plugins and shows a banner with **Manage plugins** and **Turn plugins back on**. Safe mode starts from `--safe-mode`; from the shortcut Ctrl+Shift+Alt+P, which main catches before the page (`before-input-event`), so it works even when the page's UI is hidden, and ends a page that stopped answering before reloading it (if the draft has typing not yet saved, it asks first); and at once, reloading the window, when it crashes with plugins on.

### Data

- Page data: `extensions['plugin.<id>']`, JSON, encrypted with the revision and carried by every client, publication and restore under the existing unknown-namespace rule, so readers of a publication get the data its draft had. It never holds key material and counts toward the page's size limit. Export writes Markdown only, so anything a page needs readably belongs in its block.
- Block data: the fence's text, in the page's Markdown, readable, versioned, exported and searched like any code block.
- No device storage or settings store for plugins in v1.

## How the follow-ups map onto it

- **Themes and layouts (#259, built):** a theme plugin is a manifest with `themes` (and `styles`), against published tokens and `data-region` hooks; a layout plugin is an app plugin contributing `rail`, `app.view` and `page.*` regions plus CSS (`examples/plugins/dusk-theme` and `reading-room`). Disable removes links and registrations; safe mode is the recovery that doesn't depend on the plugin's UI. The CSP already blocks remote assets. The workshop previews a staged theme through the same preview the picker uses, by its stylesheet's address.
- **Calculator (#260, built as `examples/plugins/calculator`):** a script plugin claiming `plugin:calculator/product`. The fence holds a `<field>: <value>` line per field, and other lines the host keeps as they are; the host draws the fields, validates them (a number field's type, `min`, `max`; a missing line takes the field's default) and rewrites only a changed field's line; each output's `calculate` runs in the worker, bounded at 1 s, with invalid fields, failures and outputs that read each other in a loop shown by the block. Outputs are shown, never stored. Editor inputs reach the draft through `setSource`; reader inputs stay local. Disabled, the block is a code block and survives edits; re-enabled, it is a calculator again. An authorized change to another page uses `host.pages.saveDraft` with `write` access.
- **Workshop (#257, built):** a workspace per conversation under `userData/workshop/<session>/`, written only through the main process, which takes text files with plain paths inside it. Main builds a numbered version in a worker thread with esbuild's WebAssembly build (`esbuild-wasm`, about 14 MB in the package), handing it every file in memory: imports resolve to the workspace's files and to the SDK and React as the app carries them (read in at pack time), and nothing else, so a build installs, fetches and reads nothing more. The packaged app has no vite-plus to run `wikistow-plugin build`; a native esbuild would need a binary beside the asar. A version is laid out as that command lays it out, with its source in `source/`, hashed as an install is, and served at `/plugins/<id>/workshop-<session>-<n>/` with the same per-file policy. The renderer runs it in a second runtime (`createRuntime` with a source of its own) over sample pages in memory, whose page operations reach only the samples; its views, blocks and commands show in the workshop's preview, its styles and a theme shown with the picker's preview across the app. App code in a version runs only once the person allows it for that workshop. Export and install name the version's hash and fail if the files changed; install is the usual install, whose dialog shows the hash.

## Deliberate simplifications

- Plugins are installed per device; page access is per account on that device. No sync, marketplace, signing or auto-update.
- App plugins are trusted, not sandboxed; only scripts are isolated.
- Plugins can't add Markdown syntax or inline nodes; blocks are claimed fences.
- No deletes, publishing, sharing or access changes through plugins, and moves only where nobody's access changes.
- Plugin writes are the person's; history doesn't name the plugin.
- Conflicts are reported, never merged or retried by the host.
- Every new hash re-approves; installing takes a folder (no package format).
- Loops are bounded by self-event suppression and a write rate limit, not detected.
- Disabling can't stop timers an app plugin never cleared; a restart does.

## Considered options

- **Exposing the internal registries, named commands or `ClientContext`.** Couples plugins to internals that change freely and hands them keys.
- **Plugins as enrolled agent identities.** Server-enforced scope and attribution, but each plugin would need its own keys, sealed folder keys and a credential on the device, and it wouldn't constrain in-process app code anyway. Worth revisiting if attribution matters.
- **Every view in a sandboxed iframe on its own origin.** Real isolation for rich UI, but sizing, focus, theming and editor node views across frames cost far more than the family trust model justifies. It stays the path if untrusted UI is ever needed.
- **Sharing the app's React** through import maps or shim modules. Import maps are inline scripts the CSP refuses, and both tie plugins to the app's React version and internals.
- **An interpreter for scripts** (QuickJS in WebAssembly, or SES lockdown). Deterministic budgets, but slower, larger and bespoke where a worker with a CSP is standard.
- **Code or formulas executed from page content.** A shared page must never run code nobody on this device installed.

## Consequences

- The sandbox depends on the desktop app keeping nothing in origin-wide storage that a worker can read (IndexedDB, Cache Storage, BroadcastChannel), which holds today; the runtime empties that storage at each lock, since only plugins use it. A browser tab's kept unlock (#263) holds its wrapping key in IndexedDB, but only in the browser, where no plugins run. Before plugins come to the browser, or if the desktop app ever stores anything there, scripts need an origin of their own: a sandboxed frame on a `wikistow-plugin:` origin. The same move applies if Electron ever stops applying a worker's response CSP. `apps/desktop/e2e/plugins.spec.ts` checks it: a script's `fetch` to the app's API fails.
- Plugin writes go through the same operations as the editor, so the payload, conflict and attribution rules need no plugin-specific code on the server. The server learns nothing new.
