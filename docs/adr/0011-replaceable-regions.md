---
status: built
---

# Plugins that replace parts of the app, see where the person is, and edit at the cursor

WikiStow's plugins are meant to let a person change the app in ways nobody planned, down to replacing a part of its interface they don't like (#282). [ADR 0001](0001-desktop-plugin-runtime.md) built them to add, not replace: "nothing replaces a host region", and a plugin that wants its own sidebar hides the app's with CSS and draws its own in a plugin page. This ADR amends it. Some regions become **replaceable**. App plugins get one way to see where the person is and to navigate. Plugins can insert Markdown where the person is typing. A plugin can claim inline text as well as fenced blocks.

## What changes in ADR 0001

- "Nothing replaces a host region" holds only for the regions listed here as add-only. A replaceable region shows one plugin's view in place of the app's own part, which stays the default.
- "Plugins can't add Markdown syntax or inline nodes" becomes: plugins can't add Markdown syntax, but they can claim inline code, as they claim fences (decision 7).
- Per-region props such as `AppViewProps.openPage` give way to `host.app` (decision 5). Within API 1 the old props stay, since changes are additive.
- The rejections in ADR 0001's Considered options still stand. Plugins get no internal registries, named commands or `ClientContext`, no shared React, and no code run from page content. Replacing goes through the documented region table, with plugin-facing props.

## What the code supports today

- **Regions:** nine, all add-only. Each is listed by hand four times in code (`Regions` and `REGIONS` in `packages/plugin-sdk/src/host.ts`, and `noneRegistered()` and `contributions()` in `packages/ui/src/plugins/runtime.ts`), and each is drawn by hand where it shows. #281 puts them in one table and one drawing module, which this ADR builds on.
- **What a plugin knows of the app:**
  - `host.pages` takes a `spaceId`, but nothing lists spaces.
  - Nothing says which space, folder or page the person is on.
  - Only `app.view` can navigate (`openPage`).
  - `page.shown` is delivered from the page toolbar's Plugins menu, not from the router.
- **Editing:** a command, or a view in a page region, gets a `PageHandle`. In the draft view, its `edit(change)` replaces the whole draft as the person's own edit. Nothing tells a plugin where the cursor is, and the editor's format toolbar has no region. Inside the app, both editor surfaces already put Markdown at a position: the `place` of pasted files, in `packages/ui/src/page/editor/surface.ts`.
- **Syntax:** the app's own syntaxes (wikilinks, math) come from `markdownSyntaxes` in `packages/ui/src/registries.tsx`. Each has a remark reading that runs in the reader's worker (`packages/ui/src/page/markdown.worker.ts`), a React reader, and a Milkdown node with its serializer. A body the visual editor can't write back byte for byte stays in source mode (`reader-fidelity.ts`).
- **Property references** are inline code (`` `=servings` ``) that the reader and the visual editor draw as values. Inline code is already the app's way to give text a meaning without new syntax.

## Decisions

### 1. Each region is add-only or replaceable

The region table from #281 records each region's policy.

- **Add-only:** plugins' views show beside the app's own content, in plugin order, as today.
- **Replaceable:** the region also takes `replace` registrations: `host.ui.replace(region, { id, view })`. Only one view replaces a region at a time. It draws in place of the app's own part, gets the same props, and gets `host.app`.

### 2. What can be replaced

**Replaceable, first:**

| Region | The app's part it replaces | Notes |
| --- | --- | --- |
| `space.sidebar` | A space's page tree, at every size (the phone's drawer too) | Needs the tree (decision 4) |
| `space.home` | What a space shows with no page open (today "Pick a page") | A dashboard, recent pages |
| `folder.view` | A folder's page | Gets the folder and its entries |
| `page.reader` | The body of a page as read: its published version, or the draft view's reading of it | The page's card, title, cover, toolbar and properties stay the app's. The view can draw the body itself, or with `host.app.renderMarkdown(element, markdown)`, which uses the app's reader (wikilinks, blocks, math and the rest) |
| `rail` | The rail of spaces and links | Safe mode is the way back (decision 6) |
| `search.results` | The search dialog's results for a word search | Added later (#316). The search box and `>`'s commands stay the app's |

**Never replaceable**, though plugins can still add to these where they have add-only regions:

- **The editors.** The source and visual editors, and the draft session around them (saving, conflicts, autosave, offline changes), are where a page's text could be lost. Plugins change drafts through the person's own edits instead (decision 3).
- **What comes before unlock**: sign-in, unlock, setup and recovery. No plugin runs there anyway, since approvals are encrypted.
- **The ways back**: Settings → Plugins, the safe mode banner, and the approval and update dialogs.
- **Anything where the person approves a change of keys, trust or audience**:
  - sharing, members and groups
  - pinned-key warnings and confirming an owner
  - approving an agent or a chat proposal
  - publishing, public links, moving across shares, deleting and trash
  - admin

  A view drawn there could show one thing while the person approves another. An app plugin could already do that with the page's DOM, as ADR 0001 says, but the region table must not invite it.
- **The desktop titlebar's window controls**, as ADR 0001 decided: moving the window never depends on a plugin.

Search results and the chat column wait until someone wants them (#316). As built (#316): `search.results` is replaceable, below. The chat column is parked: plugins have no way to reach the assistant, and giving them one would be a large new grant, so a chat view would have nothing to draw.

### 3. Editing at the cursor, and a region in the editor's toolbar

- **`PageHandle.editor`**, in the draft view only (null elsewhere):
  - `selection()` gives the selected text as Markdown, or `''` at a cursor.
  - `insert(markdown)` replaces the selection, or inserts at the cursor, as the person's own edit. It can be undone and autosaves.

  The source editor inserts the text. The visual editor reads it into nodes, as a paste does. Like `edit`, it counts toward the 30 writes a minute.
- **`editor.toolbar`**, an add-only region in the format toolbar of both editors, for a button or two. Its views get `{ page }` with `page.editor` set.

So a plugin can add a button that inserts Markdown, such as a table, a template snippet or one of its own blocks, without adding any syntax. This needs no Markdown syntax decision at all.

### 4. What a replacing view may read

A replaced region draws only what the plugin's page access covers. A `space.sidebar` view, for example, sees a space's tree only where it has `read` access. The person gives access as today, and where the plugin has none the region shows the app's own part.

`host.pages.tree(spaceId)` gives the whole tree within access in one call (folders, pages, titles), so a sidebar doesn't list folder by folder. It includes the pages and folders made offline and not yet sent, as the app's own tree does.

### 5. `host.app`

App plugins get these, in every view and in `activate`:

- `location`: where the person is, as `{ kind: 'space' | 'folder' | 'page' | 'plugin' | 'other', spaceId?, folderId?, pageId?, version? }`, with `subscribe(listener)`.
- `navigate(target)`: to a space, a folder, a page (`version` optional), or one of the plugin's own `app.view`s.
- `spaces.list()`: the spaces the plugin has any access in, with their names and icons.
- `renderMarkdown(element, markdown, { page })`: the app's reader, for a replacing `page.reader` or any view.

`page.shown` and a new `location.changed` event come from the router, not from a drawn menu. Scripts don't get `host.app`, since they have no interface. They keep `page.shown`.

As built (#282, PR 2): the types are `AppLocation` and `Destination` in `packages/plugin-sdk/src/host.ts`. A `plugin` location names the plugin and its view, and `other` names the space for a space's members and groups. The router gives the place; the version shown, and `page.shown` with its revision, come from the page route's own view once the page has opened, since only it knows which version that is. `location.subscribe` is `location.changed` by another name. In the workshop's preview, which runs a runtime of its own, the location is the sample page shown, `navigate` opens a sample page or one of the plugin's own pages in the preview and fails with `unsupported` for anywhere else, and `spaces.list()` gives the samples' one space.

### 6. Choosing, failing and the way back

- **Choosing:**
  - The approval dialog names the regions a plugin replaces ("Replaces the sidebar").
  - If two enabled plugins replace the same region, the first in Settings order draws it.
  - Settings → Plugins shows which plugin draws each replaced region, with **Use the app's own** per region. That choice is kept as the plugin's on/off is: per account for library plugins, per device for folder installs.
- **Failing:** a replacing view that throws, or never draws, falls back to the app's own part with the usual "*Plugin* failed here" note and **Disable**. A broken replacement never leaves the region blank.
- **The way back:** safe mode puts every region back to the app's own part, as it unloads every plugin. Replacing the rail hides the rail's links to Settings. The way back is then the safe mode shortcut, `?safe-mode` in a browser, and **Open without plugins** on the unlock page. The banner then links to Settings → Plugins.

As built (#282, PR 4): the manifest's `replaces` names the regions a plugin replaces, so the approval dialog can say so before any code runs, and `host.ui.replace` refuses the others. The library lists such a version only to apps that read `manifest=2`, as for `inline`. `REGIONS` gives each region its policy (`add` or `replace`) and what `register` takes, null for `space.home` and `folder.view`, which take only `replace`. The choice is `ownParts` beside `enabled`: in the approval in the contacts record, and in `plugins.json`, where an update keeps it. Settings' order is the store's list order, which now also orders add-only regions' views and Settings' rows (before, a plugin turned off and on again moved to the end). Settings' **Use the app's own** gives the app's part back from every plugin replacing it, and **Use *plugin*** gives it to that one, giving the app's part back from those before it. "Never draws" is a view that returns with its element still empty. `space.home` draws where `host.app.spaces.list()` names the space, and `folder.view` where `host.pages.list` reads the folder, whose answer is its `entries`, read again as the tree changes. In the workshop's preview, a replaced `space.home` shows among the plugin's other places, for the samples' space.

As built (#282, PR 5): `space.sidebar`, `page.reader` and `rail` are replaceable. `space.sidebar` is the tree and its filter: the space's name and menu, which lead to its members and sharing, and New page, which makes pages offline as a plugin can't, stay the app's. Its view gets `{ spaceId, tree }`, drawn only where the plugin can read the whole space, so a plugin given one folder doesn't hide the rest, and again as the tree changes. `tree` reads the app's own tree, the sidebar's, again once a change marked it, so it holds what waits on the device and, offline, what is kept; `list` still reads the server's. `page.reader` replaces the published version's text, below the properties: the draft view has no reading of its own, as it is the editor. Its view gets `{ page, markdown }`, the page handle and the text shown after the frontmatter, where the page is in the plugin's `tree`. The rail's view gets `{}` and needs no page access: `host.app.spaces.list()` already gives only what the plugin may see. Everything on the rail goes with it, the account menu and the offline note too. `renderMarkdown` draws through a React portal from the shell, so wikilinks, blocks and links have the app's router and queries; where the plugin can't read the page it draws a note instead. Given a bare page, it shows the files of the version shown of it, else its latest publication, else its draft; a `PageVersion` names its own. Scripts get `tree` too, as `pages.tree` in the worker's protocol.

As built (#316): `search.results` is replaceable. It is the list under the search box, for a word search: the box, the status line under it, and `>`'s command mode (#311) stay the app's. Its view gets `{ query, results }`, what was typed and the app's own results for it, so it can draw them its own way without a second index; one that ranks its own can call `host.pages.search`. It draws only where the plugin has page access and can read every result it would be given, so none goes missing; a search that finds pages beyond its access shows the app's own list. Reading whole spaces, as `space.sidebar` asks, would rule out a plugin for anyone with a folder shared with them, as access can't name the whole of a space they reach only through a share. It opens a result with `host.app.navigate`, which closes the dialog, even for the page already open. Up, down and Enter in the box move through the app's own list only, so a replacing view's results are reached with Tab. While it is drawn again for a new query, the view drawn for the last one stays. An add-only region of results beside the app's was not built.

### 7. Claimed inline code

A plugin can claim inline code written `` `plugin:<id>/<type> <text>` ``, as it claims a fence `plugin:<id>/<block>`. The manifest's `inline` lists the types it claims. Where the plugin runs, the reader and the visual editor draw the span with the plugin's view (`{ text, page, setText }`). Everywhere else (other devices, the CLI, `/p/` pages, export, search) it is the inline code it is.

The page's text never changes for being claimed. The visual editor keeps the span as an atom holding its exact source and writes it back as it was. So the plugin's code never runs in the reader's worker or the editor's serializer, and a page can't be rewritten by a plugin's mistake.

New Markdown syntax of a plugin's own, such as `==highlight==`, stays out. It would need the plugin's code in the reader's worker and in the visual editor's schema and serializer. Every device without the plugin would show it as stray characters. A serializer that lost a character would rewrite the page for everyone who edits it.

**As changed by #401 (2026-11-12):** a plugin can also claim a bare fence language, such as `dataview`, so the blocks an imported vault already has are drawn without editing them. This is not syntax of its own: a fence is Markdown every device reads, the page's text never changes for being claimed, and without the plugin the block is code, as before. The manifest's `fences` gives each language one of the plugin's `blocks` (`{ "dataview": "query" }`), drawn by the view its app code registers for that block, so the approval dialog names the languages before any code runs, and the library lists such a version only to apps that read `manifest=4`. A language is a lowercase letter, then lowercase letters, digits, `_`, `+` and `-`, and not one the app draws itself (`wikistow-query`, `mermaid`, `math`). Only app plugins claim one, and a script's form is never drawn for one: such a fence holds whatever its author wrote, on any page the person opens and whatever the plugin's page access, which app code already reads as the app does, but a sandboxed script must not be handed. Two running plugins claiming one language are settled as two replacing one region are (decision 6): the first in Settings' order that draws the block draws it, and Settings → Plugins lists each claimed language with the plugin drawing it, **Show as code**, and **Use _plugin_** for each other plugin claiming it. The choice is kept in `ownParts` as `fence:<language>`, beside the regions, so it needs no new field, and an app older than it ignores it. Unlike `plugin:<id>/<type>`, a claimed language names no plugin, so without one the block has no note naming a missing plugin: it is just code.

### 8. Trust

Replacing and `host.app` are for app plugins, which already run with the app's trust. No trust level changes. A theme plugin still replaces nothing, and its CSS can still hide anything.

## Out of scope

- Replacing the editors, or regions where trust or audience is decided.
- Plugin Markdown syntax beyond claimed inline code (and, as changed by #401, claimed fence languages).
- Storage for plugins.
- A plugin's commands outside the page's Plugins menu (an app-wide command list, shortcuts). Worth an issue of its own. (Since built: the command palette lists them (#311), and the person can give each a shortcut in Settings → Plugins (#404).)
- Replacing the whole shell (rail, sidebar and main in one view). Replacing the rail and the sidebar together gets close, and keeps the ways back.

## Considered options

- **Replace anything, through the internal registries.** This is the most freedom, but it ties plugins to the app's React components, and the editors and approval dialogs would come with it. ADR 0001 rejected it, and that still holds.
- **Keep regions add-only, and document more `data-region` hooks for hiding.** This needs no new code. But the hidden part still runs, its focus and keyboard handling still apply, and a plugin rebuilds what the app already knows, such as the tree and the location, from scattered calls.
- **Replace in a sandboxed frame.** Real isolation, but ADR 0001 rejected frames for rich UI on cost, and a replaced sidebar or reader needs focus, theming and navigation across the frame.
- **Plugin syntax through remark plugins.** That is the app's own mechanism. It is ruled out by decision 7's reasons: plugin code in the reader's worker and the editor's serializer, and pages others edit getting rewritten.
- **A sidebar plugin reading the tree without page access** (names only). The tree's names are as private as its pages, and page access is already the one thing a person gives a plugin. Folding names into page access keeps one setting.

## Consequences

- #281 comes first: the region table is where each region's policy lives.
- The workshop's preview draws replaced regions too, which #281's shared drawing gives for free.
- The SDK README's region table gains a Policy column, and the approval dialog a "Replaces" line.
- `CONTEXT.md`'s **Region** entry changes from "places … app plugins draw into" to say some are replaceable. **Plugin block** gains its inline counterpart.

## Decided (2026-11-07)

Scott approved every recommendation:

1. Replaceable regions, first set: `space.sidebar`, `space.home`, `folder.view`, `page.reader`, `rail`.
2. Never replaceable: the editors, before-unlock pages, the ways back, regions where trust or audience is decided, and the titlebar's window controls.
3. `PageHandle.editor` (`selection`, `insert`) and the add-only `editor.toolbar` region.
4. Replacing views read within page access, with `host.pages.tree`.
5. `host.app`: `location`, `navigate`, `spaces.list` and `renderMarkdown`, and events from the router.
6. With two replacements, the first in Settings order wins. The choice to use the app's own part is kept as on/off is. A failed replacement falls back.
7. Claimed inline code, and no plugin syntax of its own.

## Implementation, in pull requests

1. **The region table** (#281): one table, one drawing module, and the workshop preview drawing the real layout.
2. **`host.app` and router events**: `location`, `navigate`, `spaces.list`, `location.changed`, with `page.shown` delivered from the router.
3. **Editing at the cursor**: `PageHandle.editor` in both editors, and the `editor.toolbar` region.
4. **Replaceable regions**: `host.ui.replace`, the policy in the table, fallback on failure, Settings' **Use the app's own**, the approval dialog's line, and `space.home` and `folder.view` first.
5. **The sidebar, reader and rail**: `host.pages.tree`, `renderMarkdown`, and the three regions, with the way-back checks for the rail.
6. **Claimed inline code**: the manifest's `inline`, reader and visual-editor atoms, and checks that a span round-trips byte for byte.

2 and 3 need only 1. 4 needs 1 and 2. 5 needs 4. 6 is independent.
