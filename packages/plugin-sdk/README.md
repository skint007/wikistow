# @wikistow/plugin-sdk

What a WikiStow plugin is written against. The design and its reasons are in [ADR 0001](../../docs/adr/0001-desktop-plugin-runtime.md); the plugin library and browser plugins in [ADR 0002](../../docs/adr/0002-plugin-library-and-browser-plugins.md); `wikistow.md` §Plugins says what a person sees. Plugins run in the desktop app, installed from a folder or from the server's plugin library, and in the browser and on phones, installed from the library.

## A plugin folder

```text
wikistow-plugin.json   the manifest
src/ui.tsx             app code (optional): default-exports definePlugin(...)
src/script.ts          script code (optional): calls defineScript(...)
public/                styles, theme stylesheets, fonts, images, copied as they are
```

`wikistow-plugin build [folder]` writes `dist/`: the manifest, `ui.js` and `script.js` each bundled into one self-contained ES module (unminified, for whoever approves it), and `public/`'s files. Install `dist/` in the desktop app's Settings → Plugins, or load it there for development and press **Reload** after each build. To use it in the browser or on other computers, upload `dist/` to the library from Settings → Plugins in a computer's browser, or install it in the desktop app and use **Share to library…** there. Uploading installs it for you on all your devices, Shared with everyone on the server or Only me; file and folder names must use only letters, digits, `_`, `.` and `-`. The plugin workshop, in the browser, on a phone or in the desktop app, builds the same layout itself from a plugin draft the assistant writes, adding the draft's files under `source/`, and **Publish** there uploads it to the library and installs it for you. To work on a project of your own with the assistant, choose its folder with **Upload project folder…** on the workshop page, on a computer: the draft takes `wikistow-plugin.json` and everything under `src/` and `public/` (text files only, within 200 files, 256 KB a file and 4 MB in all), and leaves out the rest. The workshop resolves only the project's own files, this SDK and React, so other packages a project imports won't build there. There are four examples in `examples/plugins`: `page-tools` (a panel, commands, a script, a block and inline code), `calculator` (a script plugin's block), `reading-room` (a layout: a rail item, a plugin page, a page aside and CSS) and `dusk-theme`, a theme that needs no build, just a manifest and a stylesheet installed as they are.

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
| `inline` | Inline code types it claims, written `` `plugin:<id>/<type> <text>` `` (app plugins). Leave it out if it claims none: an app older than it refuses a manifest that has it, and the library lists such a version only to apps that read it. |
| `replaces` | The regions it draws in place of the app's own part (app plugins), such as `["space.home"]`, which the approval dialog names. See [Replacing a region](#replacing-a-region). Leave it out if it replaces none, for the same reason as `inline`. A region this app doesn't know is never drawn. |
| `settings` | Settings the app draws for it in Settings → Plugins, for app code or a script to read. See [Settings](#settings). Leave it out if it declares none, for the same reason as `inline`. |

Its trust level comes from what it holds: **theme** (styles only), **script** (`script`, in a worker with no network or DOM, inside a sandboxed frame with an opaque origin, so it has none of the app's storage) or **app** (`ui`, in the app's page with the app's own trust).

## The host

Both entries get a `Host` (`src/host.ts`); app code gets an `AppHost`, which adds `ui` and blocks it draws, and a script a `ScriptHost`, which adds blocks the app draws as forms.

- `host.pages`: `read`, `list`, `tree`, `search`, `create`, `createFolder`, `saveDraft`, `move`. Plain data in and out. Each call is checked against the page access the person gave the plugin, then runs the app's own operation. `saveDraft` names the revision it read as `base`; a newer one fails with `conflict`, never merged. A page's `data` is its `plugin.<id>` namespace, encrypted with the page and published with it. `tree(spaceId)` gives every folder and page of a space the plugin can read in one call, each a `list` entry with its `parentId` (null at the top, or a folder outside its access, which isn't listed), folders first: the app's own tree, so it holds what was made on this device and not sent yet, and offline what the device keeps. It is empty where the plugin can read nothing, and missing in an app older than it, so reach it as `host.pages.tree?.` in app code. A script's `tree` is always there, and an app older than it stops the script that calls it.
- `host.commands.register({ id, title, run({ page }) })`: listed in the page toolbar's Plugins menu, and in the command palette (Ctrl+Shift+P, or `>` in search) under the plugin's name, while a page is shown. A plugin with settings also gets a **_Plugin_ settings…** row there, from anywhere. `page` is the page shown, which needs no access: `page.read()`, and in the draft view `page.edit(change)`, which changes the draft through the editor as the person's own edit, and `page.editor`, which works where the person's cursor is (in split, the side they were in last): `selection()` gives what is selected as Markdown (`''` at a cursor), and `insert(markdown)` puts Markdown in place of the selection, or at the cursor, as the person's own edit, which can be undone and saves as typing does. The source editor inserts the text, so start a block with a blank line there. The visual editor reads it into the page as a paste does, except that anything but a single paragraph goes in as whole blocks, splitting the text at the cursor, so a block put after some text stays a block; one paragraph joins the text around it. Line breaks are LF both ways. `insert` counts as a write, as `edit` does. `page.editor` is null outside the draft view, and null or missing in an app older than it. A button in the `editor.toolbar` region is the usual way in: insert a table, a snippet or one of the plugin's own blocks.
- `host.settings`: the person's settings for the plugin, the same on each of their devices: `get()`, `set(settings)`, `update(patch)` and `on('changed', handler)`. See [Settings](#settings). Missing in an app older than it, so reach it as `host.settings?.` in app code. A script's is always there, and an app older than it stops the script that uses it.
- `host.events.on('page.shown' | 'draft.saved', handler)`: one run at a time per event and page, the latest waiting replacing the rest. `page.shown` comes as a page opens, wherever it is opened from, and again when the version shown changes. A plugin isn't told of its own saves, including the save its `page.read()` in the draft view makes of what is typed first, so a view that reads again on `draft.saved` doesn't keep the editor saving.
- `host.app` (app only): where the person is, and the way elsewhere, for `activate` and every view. Missing in an app older than it, so reach it as `host.app?.`.
  - `location.get()` gives where the person is: `{ kind: 'space', spaceId }` (a space with no page open), `{ kind: 'folder', spaceId, folderId }`, `{ kind: 'page', spaceId, pageId, version? }` (`version`, `draft` or `published`, is missing while the page opens), `{ kind: 'plugin', pluginId, viewId }` (an `app.view`) or `{ kind: 'other', spaceId? }` (anywhere else, with the space for a space's members or groups). `location.subscribe(listener)` calls `listener` with each new location: it is `host.events.on('location.changed', listener)`, which an app older than it refuses, so subscribe instead. Several changes made while the listener runs reach it as the latest.
  - `navigate(to)` goes there as a link would, to `{ kind: 'space', spaceId }`, `{ kind: 'folder', spaceId, folderId }`, `{ kind: 'page', spaceId, pageId, version? }` (without `version`, the one the app opens), `{ kind: 'plugin', viewId }`, one of the plugin's own `app.view`s, or `{ kind: 'settings' }`, the plugin's own row in Settings → Plugins with its settings open. It needs no page access, as the person's own links don't; what is there shows as the app shows it, and it fails with `invalid` for an ID that isn't one. An app older than `settings` fails it with `invalid` too, so catch that and hide the button.
  - `spaces.list()` gives the spaces the person can open where the plugin has any page access, as `{ spaceId, name, icon }`: the name is null where it can't be read, and `icon` is the space's emoji or null (the app may show an image or a symbol instead).
  - `renderMarkdown(element, markdown, { page })` draws Markdown into `element` with the app's reader, as a page's text is drawn: wikilinks, blocks (other plugins' too), math, diagrams and the rest, and frontmatter as the page's properties. Links resolve among `page`'s space, and its files show. A `PageVersion` (what `read()` gives) names the version whose files it shows; a bare `{ spaceId, pageId }`, the version shown of that page, else its latest publication, else its draft. Tasks stay as written, and nothing offers to make a missing page. Where the plugin can't read `page`, a note says so instead. It returns what undoes it: return that from a view. The app's styles reach it only outside a shadow root.
  - In the workshop's preview, the location is the sample page shown, `navigate` opens a sample page, one of the plugin's own pages or its settings there and fails with `unsupported` for anywhere else, `spaces.list()` gives the samples' one space (`workshop-samples`) where the manifest asks for page access, and `renderMarkdown` draws as a sample's reader does, without files or links.
  - Scripts get no `host.app`, and keep `page.shown`.
- `host.ui.register(region, contribution)` (app only): interface in one of the app's places. See [Regions](#regions).
- `host.ui.replace(region, { id, view })` (app only): a view in place of the app's own part of a region the manifest's `replaces` names. Missing in an app older than it, so reach it as `host.ui.replace?.`. See [Replacing a region](#replacing-a-region).
- `host.blocks.register({ type, view })` (app only): draws a ```` ```plugin:<id>/<type> ```` fence the manifest's `blocks` claims, in the reader and the visual editor. The view gets `{ source, page, setSource, properties, setProperty }`: the fence's text; and in the visual editor `setSource(text)`, which makes `text` the block's text as the person's edit (the view isn't drawn again for it), or null in the reader, where what a reader enters stays in the view. `properties` are the page's, as it shows them: each top-level frontmatter key as written, with its value (text, a number, `true` or `false`, `null` for an empty one, or a list of them; anything else as its source text), `{}` without frontmatter and null for frontmatter that doesn't read as properties. `setProperty(key, value)` sets one of them, changing only that value's characters: the key as written, else the first whose name matches it as `` `=key` `` does, else a new key, and each `` `=key` `` on the page follows it. In the visual editor it is the person's own edit to the draft. In the reader it is there only for an editor who can publish the page, on its latest publication, while the draft has no changes: it shows at once and is published with the page's other changes made while reading (ticked tasks among them) once they pause for a few seconds, or as the person leaves the page, as one version; one that no longer applies by then is left out, and the page says so. Elsewhere it is null. It throws a `PluginError` (`invalid`) for a key that isn't a property name (a letter or digit, then letters, digits, spaces, `_` and `-`), a value a property can't hold, or, in the editor, a value that can't be changed in place, such as one on several lines. Call it as a value is committed (blur or Enter), not on each key. An app plugin's block view is drawn again whenever the page's properties change, other than through its own `setProperty`, as a view may read any of them and has no way to take new props in place; keep what a person is typing in such a view somewhere that survives being drawn again, or commit it before moving on. A script's form is drawn by the app, which updates it in place instead, so its fields keep their text and focus as properties change. An app older than these two leaves them out (`undefined`): read that as properties unknown and nothing settable. A script's field with `property` needs an app that knows it; one without it is sent as before, so older apps still take the plugin. Keep everything else a block needs in its text: without the plugin, it is shown and exported as written.
- `host.inline.register({ type, view })` (app only): draws inline code `` `plugin:<id>/<type> <text>` `` whose type the manifest's `inline` claims, in the reader and the visual editor, as a block draws a fence. The view gets `{ text, page, setText }`: the span's text after its type (a line break in it reads as a space), and in the visual editor `setText(text)`, which makes `text` the span's text as the person's edit (the view isn't drawn again for it), or null in the reader. The page's text never changes for being claimed: the visual editor keeps the span exactly as written, and without the plugin (on another device, in the CLI, on a public page, in an export or search) it is the inline code it is. Keep what a span means in its text. `inlineSpan(pluginId, type, text)` gives a span's Markdown, with enough backticks for any in its text, and `claimedInline(code)` reads one. In the visual editor a span reads as the plugin's only once the page is read, as it opens or when Markdown is pasted, so typed by hand it stays code until then. `page-tools`'s `rating` span shows stars.
- `host.blocks.register({ type, fields, outputs })` (scripts only): a block the app draws as a form, for a fence the manifest's `blocks` claims. `fields` maps each field's ID to `{ type: 'number', label, default?, min?, max?, property? }` or `{ type: 'text', label, default?, property? }`; `outputs` maps each output's ID to `{ label, calculate(values, { page }) }`, returning a finite number or text, or a promise of one. `values` holds every field, typed by its declaration, and the other outputs: reading a field that is missing or invalid, or an output that failed, fails this output with a message saying what it needs, and outputs reading each other in a loop say so. The fence's text holds a `<id>: <value>` line per field; a missing line takes the field's `default`, and the form rewrites only the line of a field changed in the visual editor (in the reader, values stay in the form). A field with `property` (a property name, as `setProperty` takes it) is tied to that page property instead: it shows the page's value where the page has one (else its line or `default`), and sets the property, never its line, once a valid value typed into it is committed, on blur or Enter, as a number for a number field. Only a field typed in is set, and only to a value the page hasn't, so a visit never changes the page, even for a default shown where the page has no value. A field bound to a list shows its items, read-only, with a note to change it in the page's properties. A text field keeps the type of the value it replaces when its text reads as one: a number stays a number (`rating: 4` becomes `5`, not `'5'`), and `true` or `false` a boolean; a value the page has empty, or a key it hasn't yet, is typed as the page's Properties type it; anything else is text. Emptied, a text field leaves the value empty. Where the page can't change, a value entered stays in the form. `calculator`'s `recipe` block ties its Servings field to `servings`. Outputs are never stored. IDs are `[A-Za-z][A-Za-z0-9_]*`, shared by fields and outputs, and name the fence's lines, so keep them once pages use them. A block can also be drawn entirely by an app plugin's `view` (above), as `page-tools` does.
- `host.signal`: aborted when the plugin unloads, the vault locks or the person signs out. Every `register` returns a disposer, and everything registered goes on unload anyway.

A view is `(element, props) => cleanup`: draw into the element the host gives. `reactView(Component)` from `@wikistow/plugin-sdk/react` mounts a React root with the plugin's own React; style with the app's CSS variables (`var(--primary)` and the rest in `packages/ui/src/styles/theme.css`). Errors are `PluginError` with a `code` (`not-granted`, `conflict`, `timeout`, …); `instanceof PluginError` works on errors from the app's copy of the SDK too.

A script's command or event handler gets 10 seconds, as does its `defineScript` activation, and a block's calculation 1 second (one calculation runs at a time); past that its worker is ended and started again, and three failures in five minutes stop it until it is turned back on or the vault is unlocked again. It starts from a `data:` address, so it may be 1 MB at most, and inherits the sandbox frame's policy, which allows no requests (only `data:` workers), so `fetch`, `import()` and `importScripts` fail inside it. `host.pluginId` comes from the worker's name, so build with this SDK or newer: a script built before the frame reads it empty.

## Settings

A plugin keeps the person's choices for it (a width, a default folder, an on/off) as its **settings**: one JSON object per plugin and account, at most 16 KB (`SETTINGS_LIMIT`). They are kept with the person's plugin approvals, encrypted in their account's record, so they follow the person to every device and the server can't read them; a folder or development install on the desktop keeps them on that computer, per account, as it keeps its page access. The last write wins, with no history.

- `get()` gives them, each declared field (below) holding its `default` while it has no value, or while its value no longer fits the field.
- `set(settings)` replaces them, and `update(patch)` sets the top-level keys `patch` names, keeping the rest, and gives `get()`'s answer after. A value that isn't JSON, or doesn't fit its declared field, fails with `invalid`, and past 16 KB with `too-large`. They count toward the plugin's 30 writes a minute.
- `on('changed', handler)` calls `handler` with `get()`'s answer whenever they change, by the plugin itself or in Settings → Plugins. Another device's changes reach it at the next unlock, as it starts again and reads them.
- Updating the plugin keeps them, Remove deletes them, and safe mode leaves them as they are. In the workshop's preview they are kept in memory, from version to version, so trying one doesn't change the person's own.

A manifest can declare settings the app draws itself, in the plugin's row on the Plugins page under its **Settings** button, before any `settings.section`. Then a script has settings without drawing a view, and their values are checked. A theme has no code to read them, so declaring settings in one does nothing yet. Each is `{ key, label, description?, type, default? }`, `key` being `[A-Za-z][A-Za-z0-9_]*`, unique, and `default` a value the field takes:

| `type` | Drawn as | Value |
| --- | --- | --- |
| `text` | A text box, saved on Enter or leaving it | Text, at most 1,000 characters for `default` |
| `number` | A number box, saved on Enter or leaving it, with `min?` and `max?` | A finite number within them |
| `boolean` | A switch, saved at once | `true` or `false` |
| `choice` | A menu of `options: [{ value, label }]`, saved at once | One option's `value` |

A section of the plugin's own (`settings.section`) gets `{ settings }`, the same object as `host.settings`, for anything a declared field can't hold. For every enabled plugin with settings, declared or a section, the page toolbar's Plugins menu has ***Plugin* settings…**, which opens them as `navigate({ kind: 'settings' })` does. `reading-room` declares its column's width and the reading speed, and links to its settings from its page.

## Themes

A manifest's `themes` (`{ id, name, base: 'light' | 'dark', stylesheet }`) join Settings → Appearance, under the built-in palettes, while the plugin is enabled. There a person can **Preview** one (shown until they stop or leave Settings), use it, or go back to the account's palette with **Use … here** or any built-in choice. Turning the plugin off shows the palette again, and turning it back on brings the theme back.

How they rank: a preview over a chosen plugin theme, over the account's built-in choice. A plugin theme is kept on this computer, or in this browser, only. The account's choice stays what every other device shows. A theme is light or dark by its `base`: it is drawn over Light or Midnight slate, which supply any token it leaves out and the app's dark styles, and it doesn't follow the system's light or dark setting.

The stylesheet is loaded after the app's styles, only while the theme is shown. It sets the app's tokens on `:root, [data-theme]`, listed below and as `ThemeToken` (`src/theme.ts`). Their built-in values are in `packages/ui/src/styles/theme.css`. A token a theme leaves out keeps its base palette's value, and the page's alerts and code colours follow the palette's own colours until a theme sets them. Beyond tokens, it can style the app's places through their `data-region` attributes and a page's text through `.page-body`, the same in the reader and the visual editor. Mermaid diagrams are drawn in the theme's `--primary-soft`, `--primary`, `--card`, `--background`, `--muted`, `--foreground`, `--muted-foreground`, `--note`, `--note-foreground` and `--border`, in the system's fonts.

A theme is styles only: it runs no code and gets no page access. It can't load anything from another host, since the app's Content Security Policy allows styles, fonts and images from its own origin only. Fonts and images go in the plugin folder.

### Tokens

| Tokens | What they style |
| --- | --- |
| `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--border`, `--input`, `--ring` | The app's surfaces, their text, borders and the focus ring |
| `--muted`, `--muted-foreground`, `--subtle-foreground`, `--secondary`, `--secondary-foreground`, `--accent`, `--accent-foreground` | Quiet fills and text, and the hover fill and its text |
| `--primary`, `--primary-2`, `--primary-foreground`, `--primary-soft`, `--primary-ink` | The brand colour, its gradient start, text on it, its soft fill and text on that |
| `--strong`, `--strong-foreground`, `--destructive`, `--destructive-foreground`, `--destructive-badge-foreground` | Dark buttons and avatars, and destructive buttons and badges |
| `--status-published`, `--status-published-foreground`, `--status-draft`, `--status-draft-foreground`, `--draft-dot`, `--update-dot` | Status pills and dots |
| `--note`, `--note-foreground`, `--table`, `--table-head`, `--tree-guide` | Notes, tables and the sidebar's tree lines |
| `--glass`, `--glass-foreground`, `--cover` | The banner's toolbar and the palette's own banner |
| `--folder-green`, `--folder-orange`, `--folder-blue`, `--folder-pink`, `--folder-purple` | Folder tints |
| `--card-shadow`, `--badge-shadow`, `--slider-shadow`, `--shade`, `--shade-strong`, `--backdrop` | Shadows (`box-shadow` values), the shade over a bright fill when hovered and pressed, and the colour behind a dialog |
| `--alert-note`, `--alert-tip`, `--alert-important`, `--alert-warning`, `--alert-caution` | A page's alerts: each type's label and edge |
| `--code-comment`, `--code-keyword`, `--code-string`, `--code-number`, `--code-title`, `--code-deletion` | Highlighted code |
| `--banner-sunrise`, `--banner-ocean`, `--banner-meadow`, `--banner-lavender`, `--banner-dusk`, `--banner-stone` | The banner presets, the same in every palette |
| `--font-sans`, `--font-mono` | Type |
| `--radius-card`, `--radius-tile`, `--radius-control`, `--radius-row`, `--radius-folder` | Corner radii |
| `--spacing`, `--sidebar-width` | The unit every gap and padding is a multiple of, and the space's sidebar on a wide screen |

## Regions

App plugins put interface in these places. In a region whose policy is **Add**, `host.ui.register(region, { id, … })` puts it beside the app's own content: several plugins in one place show in the order Settings lists them, then in the order each registered. A region whose policy is **Replace** can be drawn by one plugin in place of the app's own part, with `host.ui.replace` (below). Each view gets an element to draw into. A plugin's CSS can hide or rearrange the app's content through `data-region`. A region this app doesn't have fails with `unsupported`. `REGIONS` in `src/host.ts` lists them, as this table does.

| Region | Policy | Registers | Where | On a phone |
| --- | --- | --- | --- | --- |
| `rail` | Replace | `{ id, title, icon?, opens }` | A rail item opening the plugin's `app.view` named `opens`; replaced, the whole rail, its view getting `{}` | In the navigation drawer |
| `space.sidebar` | Replace | — | A space's page tree, under its name and New page; its view gets `{ spaceId, tree }`, what `host.pages.tree` gives | In the navigation drawer |
| `app.view` | Add | `{ id, title, view }` | A page of its own in the main area; its view gets `openPage(page)` | The same |
| `space.home` | Replace | — | What a space shows with no page open (Pick a page); its view gets `{ spaceId }` | The same |
| `folder.view` | Replace | — | A folder's page; its view gets `{ folder, entries }`, what `host.pages.list` gives | The same |
| `page.reader` | Replace | — | The text of a page as read, under its title and properties; its view gets `{ page, markdown }` | The same |
| `page.toolbar` | Add | `{ id, view }` | The page's toolbar, before the Plugins menu | The same; keep it to a button |
| `editor.toolbar` | Add | `{ id, view }` | The editor's format toolbar, in the draft view (a bar of its own over the source editor); its view's `page.editor` is set | The same; keep it to a button |
| `page.header` | Add | `{ id, view }` | Above the page's text, under the banner | The same |
| `page.footer` | Add | `{ id, view }` | Below the page's text | The same |
| `page.aside` | Add | `{ id, view }` | Beside the text, under its contents, where the page card is 960px wide or more | Below the page |
| `page.panel` | Add | `{ id, title, view }` | A sheet opened from the Plugins menu | The same |
| `settings.section` | Add | `{ id, title, view }` | Under the plugin's row on the Plugins page (Settings → Plugins), opened by its **Settings** button; its view gets `{ settings }`, what `host.settings` gives | The same |
| `app.titlebar` | Add | `{ id, view }` | The desktop app's titlebar, before its menu: a small button or two, which the view names for screen readers | Not in the browser, which has no titlebar of its own |

The page places' views get `{ page }`, the same handle a command gets, and `editor.toolbar`'s are drawn only in the draft view; settings sections get `{ settings }`, the plugin's `host.settings` (missing in an app older than it), titlebar buttons get nothing, and every view can use `host.app`, so a titlebar button can open the plugin's own page. Rail items, plugin pages and titlebar buttons show only while the vault is open, as app code runs only then. Pressing a titlebar button never moves the window, and moving the window or its own buttons never depend on a plugin. `examples/plugins/reading-room` has one.

The `data-region` hooks, for CSS (`DATA_REGIONS` in `src/host.ts`):

| `data-region` | What it marks |
| --- | --- |
| `app` | The whole window |
| `titlebar` | The desktop app's titlebar |
| `rail` | The rail |
| `topbar` | The phone's top bar |
| `main` | Beside the rail |
| `sidebar` | A space's page tree |
| `folder` | A folder's page |
| `page` | The page card |
| `page.cover` | Its banner |
| `page.toolbar` | Its toolbar |
| `page.body` | The text and its aside |
| `page.content` | The page's column: header, title, text, footer |
| `page.header` | Plugins' views above the text, only while a plugin fills it |
| `page.footer` | Plugins' views below the text, only while a plugin fills it |
| `page.aside` | The contents and plugins' views beside the text, only while a plugin fills it |
| `editor.toolbar` | Plugins' buttons in the editor's format toolbar, only while a plugin fills it |
| `app.view` | A plugin's page |
| `settings` | Settings |
| `workshop` | The plugin workshop |
| `whats-new` | What's new |
| `safe-mode` | The safe mode banner |

If a plugin hides the way back, Ctrl+Shift+Alt+P restarts the app without plugins.

### Replacing a region

`host.ui.replace(region, { id, view })` draws `view` in place of the app's own part of a **Replace** region, for a region the manifest's `replaces` names (`invalid` otherwise). Registering it again replaces the view before; the disposer gives the region back. The view gets the props the table names, and `host.app` as every view does. Its element fills the region, where the app's own part would be: draw a card of your own (`var(--card)`, `var(--radius-card)`, `var(--card-shadow)`) if you want one.

- **Page access.** A view draws only where the plugin has page access: `space.home` in a space where it has any, `folder.view` in a folder it can read, its `entries` what `host.pages.list` gives there, `space.sidebar` in a space it can read all of (not only some folders there, so nothing the person could find there goes missing), its `tree` what `host.pages.tree` gives, and `page.reader` on a page it can read. Elsewhere the app's own part shows. The rail needs none: `host.app.spaces.list()` gives the spaces it may show. `folder.view` and `space.sidebar` are drawn again when what they show changes, `page.reader` for another page or version, or when its text changes as it is read; `space.home` only for another space, and the rail never.
- **The page's text.** `page.reader` replaces the published version's text only: the page's card, banner, title, toolbar and properties stay the app's, and so does the draft view, which is the editor. Its view gets `{ page, markdown }`: the page handle, as the page's other places get it, and the text shown after the frontmatter, with what was changed while reading it (such as a ticked task). `host.app.renderMarkdown(element, markdown, { page: page.page })` draws it as the app would, so a view can draw it with something of its own around it.
- **The sidebar and the rail.** Both are replaced at every size, in the phone's navigation drawer too, which closes as the plugin navigates. `space.sidebar` is the page tree and its filter, in the sidebar's card: the space's name and menu (members, sharing, export) and New page above it, and an agent's activity below it, stay the app's. Draw links with `host.app.navigate`, and what is current with `host.app.location`.
- **Failing.** A view that throws, or returns having drawn nothing in its element (or in an open shadow root it attached there), gives the region back to the app's own part, with a note naming the plugin and **Disable** above it, and Settings → Plugins notes it beside the plugin. Draw something at once, such as a box filled in later: an empty element is a failed view.
- **Choosing.** If two enabled plugins replace a region, the first in Settings → Plugins' order draws it: folder installs on the desktop, then library plugins, each in the order installed (Settings lists plugins with a problem first, but that doesn't change which draws). There each replaced region says which plugin draws it, with **Use the app's own**, and a button to use each other plugin replacing it. That choice is kept as the plugin's on/off is: per account for a library plugin, on this computer for a folder install.
- **The way back.** Safe mode puts every region back to the app's own part, as it runs no plugins. A plugin drawing the rail hides everything on it: the spaces, Search, Shared, Trash, Agents, Settings, the account menu (What's new, Lock vault, Sign out, an update) and the offline note, so draw what your rail needs of them with `host.app`. The way back to Settings is then safe mode: Ctrl+Shift+Alt+P, `?safe-mode` in a browser's address, or **Open without plugins** on the unlock page. Its banner links to Settings → Plugins.

