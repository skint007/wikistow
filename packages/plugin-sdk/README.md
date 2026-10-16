# @wikistow/plugin-sdk

What a WikiStow plugin is written against. The design and its reasons are in [ADR 0001](../../docs/adr/0001-desktop-plugin-runtime.md); the plugin library and browser plugins in [ADR 0002](../../docs/adr/0002-plugin-library-and-browser-plugins.md); `wikistow.md` §Plugins says what a person sees. Plugins run in the desktop app, installed from a folder or from the server's plugin library, and in the browser and on phones, installed from the library.

## A plugin folder

```text
wikistow-plugin.json   the manifest
src/ui.tsx             app code (optional): default-exports definePlugin(...)
src/script.ts          script code (optional): calls defineScript(...)
public/                styles, theme stylesheets, fonts, images, copied as they are
```

`wikistow-plugin build [folder]` writes `dist/`: the manifest, `ui.js` and `script.js` each bundled into one self-contained ES module (unminified, for whoever approves it), and `public/`'s files. Install `dist/` in the desktop app's Settings → Plugins, or load it there for development and press **Reload** after each build. To use it in the browser or on other computers, upload `dist/` to the library from Settings → Plugins in a computer's browser, or install it in the desktop app and use **Share to library…** there. Uploading installs it for you on all your devices, Shared with everyone on the server or Only me; file and folder names must use only letters, digits, `_`, `.` and `-`. The plugin workshop, in the browser, on a phone or in the desktop app, builds the same layout itself from a plugin draft the assistant writes, adding the draft's files under `source/`, and **Publish** there uploads it to the library and installs it for you. To work on a project of your own with the assistant, choose its folder with **Upload project folder…** on the workshop page, on a computer: the draft takes `wikistow-plugin.json` and everything under `src/` and `public/` (text files only, within 200 files, 256 KB a file and 4 MB in all), and leaves out the rest. The workshop resolves only the project's own files, this SDK and React, so other packages a project imports won't build there. There are four examples in `examples/plugins`: `page-tools` (a panel, commands, a script and a block), `calculator` (a script plugin's block), `reading-room` (a layout: a rail item, a plugin page, a page aside and CSS) and `dusk-theme`, a theme that needs no build, just a manifest and a stylesheet installed as they are.

The manifest (`src/manifest.ts` has the schema):

| Field | |
| --- | --- |
| `id` | `[a-z][a-z0-9-]{1,39}`. Names its page data (`plugin.<id>`), commands and blocks. |
| `name`, `version`, `description` | Shown when it is approved. Every new build asks for approval again. |
| `api` | `1`, the host interface version. |
| `ui`, `script` | The built files, if any. |
| `styles` | Stylesheets loaded while it is enabled. |
| `themes` | `{ id, name, base: 'light' \| 'dark', stylesheet }`, for the theme picker. See [Themes](#themes). |
| `access` | `none`, `read` or `write`: the most page access the person may give it. |
| `blocks` | Fenced block types it claims, written `plugin:<id>/<block>` (#260). |

Its trust level comes from what it holds: **theme** (styles only), **script** (`script`, in a worker with no network or DOM, inside a sandboxed frame with an opaque origin, so it has none of the app's storage) or **app** (`ui`, in the app's page with the app's own trust).

## The host

Both entries get a `Host` (`src/host.ts`); app code gets an `AppHost`, which adds `ui` and blocks it draws, and a script a `ScriptHost`, which adds blocks the app draws as forms.

- `host.pages`: `read`, `list`, `search`, `create`, `createFolder`, `saveDraft`, `move`. Plain data in and out. Each call is checked against the page access the person gave the plugin, then runs the app's own operation. `saveDraft` names the revision it read as `base`; a newer one fails with `conflict`, never merged. A page's `data` is its `plugin.<id>` namespace, encrypted with the page and published with it.
- `host.commands.register({ id, title, run({ page }) })`: listed in the page toolbar's Plugins menu. `page` is the page shown, which needs no access: `page.read()`, and in the draft view `page.edit(change)`, which changes the draft through the editor as the person's own edit.
- `host.events.on('page.shown' | 'draft.saved', handler)`: one run at a time per event and page, the latest waiting replacing the rest. A plugin isn't told of its own saves, including the save its `page.read()` in the draft view makes of what is typed first, so a view that reads again on `draft.saved` doesn't keep the editor saving.
- `host.ui.register(region, contribution)` (app only): interface in one of the app's places. See [Regions](#regions).
- `host.blocks.register({ type, view })` (app only): draws a ```` ```plugin:<id>/<type> ```` fence the manifest's `blocks` claims, in the reader and the visual editor. The view gets `{ source, page, setSource }`: the fence's text; and in the visual editor `setSource(text)`, which makes `text` the block's text as the person's edit (the view isn't drawn again for it), or null in the reader, where what a reader enters stays in the view. Keep everything a block needs in its text: without the plugin, it is shown and exported as written.
- `host.blocks.register({ type, fields, outputs })` (scripts only): a block the app draws as a form, for a fence the manifest's `blocks` claims. `fields` maps each field's ID to `{ type: 'number', label, default?, min?, max? }` or `{ type: 'text', label, default? }`; `outputs` maps each output's ID to `{ label, calculate(values, { page }) }`, returning a finite number or text, or a promise of one. `values` holds every field, typed by its declaration, and the other outputs: reading a field that is missing or invalid, or an output that failed, fails this output with a message saying what it needs, and outputs reading each other in a loop say so. The fence's text holds a `<id>: <value>` line per field; a missing line takes the field's `default`, and the form rewrites only the line of a field changed in the visual editor (in the reader, values stay in the form). Outputs are never stored. IDs are `[A-Za-z][A-Za-z0-9_]*`, shared by fields and outputs, and name the fence's lines, so keep them once pages use them. A block can also be drawn entirely by an app plugin's `view` (above), as `page-tools` does.
- `host.signal`: aborted when the plugin unloads, the vault locks or the person signs out. Every `register` returns a disposer, and everything registered goes on unload anyway.

A view is `(element, props) => cleanup`: draw into the element the host gives. `reactView(Component)` from `@wikistow/plugin-sdk/react` mounts a React root with the plugin's own React; style with the app's CSS variables (`var(--primary)` and the rest in `packages/ui/src/styles/theme.css`). Errors are `PluginError` with a `code` (`not-granted`, `conflict`, `timeout`, …); `instanceof PluginError` works on errors from the app's copy of the SDK too.

A script's command or event handler gets 10 seconds, as does its `defineScript` activation, and a block's calculation 1 second (one calculation runs at a time); past that its worker is ended and started again, and three failures in five minutes stop it until it is turned back on or the vault is unlocked again. It starts from a `data:` address, so it may be 1 MB at most, and inherits the sandbox frame's policy, which allows no requests (only `data:` workers), so `fetch`, `import()` and `importScripts` fail inside it. `host.pluginId` comes from the worker's name, so build with this SDK or newer: a script built before the frame reads it empty.

## Themes

A manifest's `themes` (`{ id, name, base: 'light' | 'dark', stylesheet }`) join Settings → Appearance, under the built-in palettes, while the plugin is enabled. There a person can **Preview** one (shown until they stop or leave Settings), use it, or go back to the account's palette with **Use … here** or any built-in choice. Turning the plugin off shows the palette again, and turning it back on brings the theme back.

How they rank: a preview over a chosen plugin theme, over the account's built-in choice. A plugin theme is kept on this computer, or in this browser, only. The account's choice stays what every other device shows. A theme is light or dark by its `base`: it is drawn over Light or Midnight slate, which supply any token it leaves out and the app's dark styles, and it doesn't follow the system's light or dark setting.

The stylesheet is loaded after the app's styles, only while the theme is shown. It sets the app's tokens on `:root, [data-theme]`. `ThemeToken` (`src/theme.ts`) lists them: the palette's colours, `--card-shadow` and `--cover`, then `--font-sans`, `--font-mono`, the radii `--radius-card`, `--radius-tile`, `--radius-control`, `--radius-row`, `--radius-folder`, and `--spacing`, the unit every gap and padding is a multiple of. Their built-in values are in `packages/ui/src/styles/theme.css`. Beyond tokens, it can style the app's places through their `data-region` attributes and a page's text through `.page-body`, the same in the reader and the visual editor.

A theme is styles only: it runs no code and gets no page access. It can't load anything from another host, since the app's Content Security Policy allows styles, fonts and images from its own origin only. Fonts and images go in the plugin folder.

## Regions

App plugins put interface in these places with `host.ui.register(region, { id, … })`. Each view gets an element to draw into. Several plugins in one place show in the order Settings lists them, then in the order each registered. Nothing replaces the app's own content, but a plugin's CSS can hide or rearrange it through `data-region`. A region this app doesn't have fails with `unsupported`.

| Region | Registers | Where | On a phone |
| --- | --- | --- | --- |
| `rail` | `{ id, title, icon?, opens }` | A rail item opening the plugin's `app.view` named `opens` | In the navigation drawer |
| `app.view` | `{ id, title, view }` | A page of its own in the main area; its view gets `openPage(page)` | The same |
| `page.toolbar` | `{ id, view }` | The page's toolbar, before the Plugins menu | The same; keep it to a button |
| `page.header` | `{ id, view }` | Above the page's text, under the banner | The same |
| `page.footer` | `{ id, view }` | Below the page's text | The same |
| `page.aside` | `{ id, view }` | Beside the text, under its contents, where the page card is 960px wide or more | Below the page |
| `page.panel` | `{ id, title, view }` | A sheet opened from the Plugins menu | The same |
| `settings.section` | `{ id, title, view }` | A card in Settings, after Plugins | The same |

The page places' views get `{ page }`, the same handle a command gets. Rail items and plugin pages show only while the vault is open, as app code runs only then.

The `data-region` hooks, for CSS: `app` (the whole window), `rail`, `topbar` (the phone's top bar), `main` (beside the rail), `sidebar` (a space's page tree), `page` (the page card), `page.cover`, `page.toolbar`, `page.body` (the text and its aside), `page.content` (the page's column: header, title, text, footer), `page.header`, `page.footer` and `page.aside` (these three only while a plugin fills them), `app.view`, `settings` and `safe-mode`. If a plugin hides the way back, Ctrl+Shift+Alt+P restarts the app without plugins.

