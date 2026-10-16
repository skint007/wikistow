# WikiStow interface design

The chosen visual direction for the web and Linux desktop interface. It supports the [implementation spec](../wikistow.md), which still owns behavior and security. This document covers layout, components, and theme.

Status: direction chosen 2026-10-01. Layout, palettes, page views, banners, folder defaults, per-palette accents, and account-synced themes are agreed. The phone layout is I, Drawer. Component mapping and the light-palette contrast fixes are to validate during the build.

## Reference material

| File | What it is |
| --- | --- |
| [design/direction-h.html](design/direction-h.html) | Standalone reference mock of the chosen layout, with palette switcher and token swatch table. Its CSS uses the production token names. |
| [design/theme.css](design/theme.css) | Source of truth for colors, radii, shadow, and font. Tailwind 4 `@theme inline` + shadcn variable names, four palettes. |
| [layout-mocks.html](layout-mocks.html) | The whole exploration: desktop variants A to H and phone variants I to L, with notes and a comparison table. History only. Its CSS uses short mock variable names (mapping below). |
| [Public exploration link](https://plan.d96.info/p/1G15hGMs37sfDrl5) | Published copy of `layout-mocks.html`. |
| [Public reference link](https://plan.d96.info/p/adtjpiP83P94Ij73) | Published copy of `design/direction-h.html`. |

## How we got here

Round 1 explored five layouts: Workbench, Rail, Library, Console, and Homey. Rails (B) and Homey's rounded cards and color-coded folder list (E) were preferred. Round 2 rendered E in dark mode (F) and combined B's space rail with E's cards (G). Round 3 replaced G's Draft / Published / History / Access tabs with F's status pills, producing **H: Rail + Cards with status pills**.

## Layout

There is no top bar. Navigation lives in the rail, so both the tree and the page get the full window height.

```text
┌──────┬────────────────────┬──────────────────────────────────────────────┐
│ rail │ sidebar card       │ page card                                    │
│      │ ┌ space header ┐   │ ┌ cover band ─────────────────────────────┐  │
│ [SK] │ [ + New page     ] │ │ (Family › Recipes)    👤 History Share  │  │
│ [🏡] │ [ Filter pages  ]  │ │                              [Publish]  │  │
│ [📚] │ 🏠 Home & House  3 │ └─[🍞]────────────────────────────────────┘  │
│ [ + ]│ 🍲 Recipes       5 │   Sourdough starter                          │
│ ──── │  │ Grandma's chili │   (✓ Published v4)(✎ Draft has 3 changes)    │
│ Srch │  │ Sourdough    ●  │   (J Jo · Sep 28)(🤖 kitchen-agent · 1 h)    │
│ Rcnt │  │ 🥘 Weeknight  2 │                                              │
│ Shrd │ ✈️ Travel        2 │   body, full width            On this page   │
│ Agnt │ 🩺 Health        2 │                                              │
│      │ Start here         │                                              │
│ Sett │ ┌ agent activity ┐ │                                              │
│ (SK) │ └────────────────┘ │                                              │
└──────┴────────────────────┴──────────────────────────────────────────────┘
```

| Region | Specification |
| --- | --- |
| Shell | `background`. Grid columns `70px 280px 1fr`, gap 14px, padding 14px on top, right, and bottom, 0 on the left (the rail centers itself in its 70px column). |
| Cards | `card` surface, `rounded-card` (18px), `shadow-card`. The sidebar and page are both cards; the rail is not. |
| Rail: spaces | One 44px tile per space, `rounded-tile` (14px), showing an emoji or initials. Active: `primary-soft` fill, 2px `primary` ring, and a 4px `primary` bar on the rail's left edge. A dashed tile creates a new space. A 28px divider follows. |
| Rail: navigation | Search, Recent, Shared, Agents. A flexible spacer, then Settings and the 36px account avatar. Each button is 56px wide with a 16px icon over a 10px bold label. Labels stay visible; B's unlabeled icons were a known weakness. The avatar opens the account menu: name and email, then Administration (for admins), Lock vault and Sign out, and last the running version (`0.2.0` for a release, `0.2.0+<commit>` otherwise), set when the web app is built. In the desktop app, when a newer stable release is out, a 10px `update-dot` sits on the avatar's top right corner, ringed in the background color, and the avatar's label becomes "Account, update available". The menu then shows **Update available** above the version: the new and installed versions, how to update for the way the app was installed (an AUR helper, the release's `.deb` or `.rpm`, or the release page when unknown), and a link to the release that opens in the system browser, described by that text. The browser shows neither. |
| Sidebar header | 38px space tile (gradient `primary-2` → `primary`), space name, member count with an avatar stack, and a chevron that opens the space menu. The count is for owners. The menu holds **Export…** for everyone, and for owners also **Share space** and **Members and owners**. Someone who holds only folders of a space sees "Shared with you" instead of its name. |
| Sidebar actions | Full-width **New page** (`primary`, `rounded-control`). A filter field below (`muted`, `rounded-row`). There is no import button; see [Import](#import). |
| Folder tree | Scrolls inside the card. See [Folder tree](#folder-tree). |
| Agent activity | Pinned to the bottom of the sidebar. `muted` card, `rounded-control`, bot icon in `primary`, showing the most recent agent edit in this space and whether it touched only a draft. |
| Cover band | 120px, `bg-cover-band` (the `--cover` gradient), top corners match the card. It holds a glass toolbar: breadcrumbs pill (Space › Folder), viewers, **History**, **Share**, then the view's main action in solid `primary`: **Edit** on the published view, **Publish** on the draft view. See [Page views](#page-views). |
| Page emoji | 72px badge, `card` background, `rounded-card`, overlapping the cover bottom by 26px at 44px from the left. |
| Page header | Title 32px / 800 weight, then the status pill row. |
| Body | As wide as the card, less its padding, 40px 44px, and the table of contents beside it. Wide code and tables scroll within their own box, and long words break, so nothing widens the page. 15.5px / 1.65. H2 20px / 800. |
| Table of contents | Published view, on a page with two or more headings: **On this page**, its headings in order, indented by level, each a link to its own heading, repeated text included (the reader's unique heading ids). Where the card is at least 960px wide it's a 208px column beside the body that stays in view as the card scrolls; narrower, a collapsed disclosure above the body. The draft view has none, so the editor gets the width. |

### Folder tree

- Folder row: 28px tinted tile (`folder-*`, `rounded-folder`) with the folder's emoji, bold name, a count pill (`muted`), and a chevron that rotates 90° when open. Row hover is `accent`, `rounded-control`.
- Children indent 20px. A 2px `tree-guide` line runs down the left of each open folder.
- Page row: `subtle-foreground`, `rounded-row`, padding 6px 10px 6px 18px. Selected: `primary-soft` fill, `primary-ink` text, bold.
- A 7px `draft-dot` marks a page with unpublished changes or no published version. The dot carries an "Unpublished changes" label for assistive technology.
- Order: folders, then loose pages, as in the mocks. Sorting rules are not decided.

Five folder tints exist: green, orange, blue, pink, purple. A new folder starts with ⭐ on the blue tint (`folder-blue`) until someone changes it, so nobody has to choose when creating one. The emoji and tint are folder metadata. Like names, they are content, so they must be encrypted with the folder's other client-side metadata rather than stored as plain server fields.

### Page views

A page has two views: **published** (read-only) and **draft** (the editor). Opening a page from the tree, a link, or search shows the latest published version. Editing happens only in the draft view, which autosaves, so there is no separate edit mode.

| | Published view | Draft view |
| --- | --- | --- |
| Who | Everyone with read access. The default view. | Editors and publishers. |
| Body | Latest published version, read-only, with its table of contents. | The draft in the editor, with an editing bar (autosave status, Source / Split / Visual switch). The editor fills the height the card has left, at least 40% of the window (on phones, the window less the top bar), and a long page scrolls within it. Split puts the source and the visual editor side by side, or one above the other, each half as tall, where the card is under 800px wide. |
| Pills | **Published vN** outlined as the current view. **Draft has N changes** links to the draft view. | **Draft** outlined as the current view. **Published vN** links back. |
| Toolbar action | **Edit** opens the draft view. | **Publish** (publishers only) and **Done**, which returns to the published view. |

Rules:

- Readers never see the Draft pill, Edit, Publish, or agent-edit pills, because they cannot read drafts.
- The Draft pill appears only when the draft differs from the latest published version. Edit stays available to editors either way, since a draft always exists.
- Publish appears only on the draft view, so the person publishing has the draft in front of them. Editors without publish permission see no Publish button.
- A page with no published version opens on the draft view for editors, with a **Not published yet** pill instead of Published vN. Readers don't see it in the tree at all.
- The view is part of the URL (for example `?view=draft`) so links to a draft work and the browser's Back button returns to the published view.
- Access lives in the **Share** dialog, which shows and changes who can read, edit, and publish. **History** opens a side sheet with published versions and restore.
- **Share** is for owners. On a page it opens the share the page is in, or offers its folder (the space, for a top-level page). See [Sharing](#sharing).
- A page published from another page (a **copy**, see [Publishing to another space](#publishing-to-another-space)) has no draft until it is detached: editors see its published view with no **Edit**, and publishers get **Detach to edit…** in its place.

The reference mock demonstrates these views. Use **View as** to switch between publisher, editor, and reader.

### Status pills

Each pill states its meaning in words; the icon and color are extras. Pills that change the view are buttons with a trailing ›. The pill for the current view gets a 1.5px inset outline in its text color and drops the ›.

| Pill | When | Style |
| --- | --- | --- |
| ✓ Published vN | A published version exists. Links to the published view. | `status-published` |
| ✎ Draft has N changes | Editors only, when the draft differs from the latest published version. Links to the draft view. | `status-draft` |
| ✎ Not published yet | Editors only, when no published version exists. | `status-draft` |
| (avatar) Name · date | The person or agent who published the shown version. | `muted` / `subtle-foreground` |
| 🤖 agent · time | Editors only, for the latest agent edit when it is more recent than the latest publish. | `muted` / `subtle-foreground` |
| ↗ Published from another page | A copy's published view. It names the source, "Published from “Title”", only when the viewer's app opens the source version the copy names, and finds its signed record's hash, title and text match the copy; it is a label, never a link. | `muted` / `subtle-foreground` |

Pills are full radius, 12.5px, 700 weight, padding 3px 10px, gap 6px.

### Banners and page emoji

Each page can set its own banner and emoji, and both are optional.

- **Banner**: one of three kinds.
  - The theme gradient, which follows the active palette. This is the default.
  - One of six preset gradients: Sunrise, Ocean, Meadow, Lavender, Dusk, and Stone (`--banner-*` in `theme.css`). Presets look the same in every palette.
  - An uploaded image. It covers the 120px band (`background-size: cover`). The person choosing it sets a vertical focal point so faces and subjects stay in view.
- **Emoji**: any emoji, shown in the 72px badge. Pages have no default emoji. Without one, the badge is hidden and the title moves up into the space it used.
- **Where it changes**: on the draft view, from a **Banner** button in the cover toolbar or by clicking the emoji badge. Banner and emoji belong to the page version, so readers see a change after it is published, like any other edit.
- **Image banners are attachments.** They are encrypted on the client and share the audience of the version that includes them, as the spec requires for attachments. Only uploads are allowed, not remote URLs; this keeps the spec's rule that reading a private page must not contact third-party hosts. *Proposed:* resize on the client before encrypting, for example to 1600px wide in WebP, so banners stay small.
- **How it renders**: the page card overrides `--cover`, which `bg-cover-band` paints. Use `--cover: var(--banner-ocean)` for a preset, or `--cover: url(<decrypted blob URL>)` with `--cover-focal: 30%` for an image. Without an override the palette's gradient shows. Decrypted images become local blob URLs, never server URLs.
- **Toolbar legibility**: the glass toolbar keeps its text at 5.2:1 or better over every preset and over pure white or black images in all four palettes (see [Contrast](#contrast)). The reference mock's **Banner** buttons show the theme gradient, all six presets, and an image.

### Page content styles

- Wiki links: `primary-ink` on `primary-soft`, bold, small radius. Distinct from external links, which are not yet styled.
- Missing wiki links (editors only): `muted-foreground` text with a dashed `border`-colored underline, no fill. Readers see plain text instead, as the [implementation spec](../wikistow.md#wikilinks) requires.
- Inert Obsidian syntax (page embeds, block references): shown as `muted-foreground` monospace text.
- Highlighted code: on the code block's `muted`, keywords in `primary-ink`, strings in `status-published-foreground`, numbers and variables in `status-draft-foreground`, comments in italic `subtle-foreground`, and names of functions, types and tags in blue (`#2b5fb4`, `#8ab4f8` in the dark palettes). Each is 4.5:1 or better on `muted` in all four palettes.
- Code block label: the block's language above its code, `text-xs` mono in `subtle-foreground` on the block's `muted`. In the visual editor it's a Picker styled the same, a button as wide as its value with a chevron, `rounded-row`, `background/60` on hover and while open, with a `ring` outline while focused.
- Properties box (frontmatter): between the status pills and the body. `muted` background, `rounded-control`, 13px bold `subtle-foreground` "Properties" label with a chevron, collapsed by default. Expanded, it shows the raw block in monospace, editable only on the draft view. Hidden when the page has no frontmatter.
- Callouts: "sticky note" in `note` / `note-foreground`, rotated −0.6°, corner radius 4px 4px 14px 4px.
- GitHub alerts (`> [!NOTE]` and the like): a block quote with a 4px left border and a bold label with its lucide icon above the text, both in the alert's colour, text in `foreground`. Note: `folder-blue` with blue (`#2b5fb4`, `#8ab4f8` in the dark palettes). Tip: `status-published` with `status-published-foreground`. Important: `folder-purple` with purple (`#6d3fc0`, `#c4b5fd`). Warning: `status-draft` with `status-draft-foreground`. Caution: `destructive` at 10% with red (`#b02525`, `destructive` in the dark palettes). Each label is 4.5:1 or better on its background, over `card` or `background`, in all four palettes. In the visual editor the label is the quote's type picker, above the marker, which stays as `muted-foreground` monospace text on a line of its own. An ordinary quote's picker reads Quote, `text-xs` in `subtle-foreground`, the way a code block's language picker does. Each picker is a Picker (`rounded-row`, `background/60` on hover and while open) of Quote, Note, Tip, Important, Warning and Caution, each with its icon.
- Tables: `table` background, `table-head` header row, `rounded-control`, 1px `border` between rows.

## Palettes

All four palettes share one token set; only values change. The theme provider sets `data-theme` on `<html>`. Each palette keeps its own accent (agreed): teal for slate, coral for warm and light, violet for OLED.

The theme choice is synced to the account (agreed). It is an account setting, not encrypted content, so the server stores it with the account's other settings. Choices are Light, Midnight slate, Warm charcoal, OLED black, and System. System follows the operating system, using Light or Midnight slate. Each client caches the last choice (local storage for the web app, which a small external boot script reads to set `data-theme` before first paint, so the HTML stays static and the CSP needs no inline script; local settings for desktop) and applies the synced value once the account loads.

In the desktop app, enabled plugins' themes are listed under the palettes in Settings → Appearance, each with Preview. A plugin theme is kept on that computer only and drawn over Light or Midnight slate, by its base. While one is on, a line says so with **Use *palette* here**, which goes back to the account's choice; choosing a palette does too. Previewing shows a bar with **Use *theme*** and **Stop preview**, and leaving Settings stops it; a workshop's theme preview shows there with **Stop preview** too, and goes on when Settings is left.

| Palette | `data-theme` | Primary | Notes |
| --- | --- | --- | --- |
| Midnight slate | `slate` | Teal `#2dd4bf` | The palette H was reviewed in. Proposed default for dark and for "system" in dark mode. |
| Warm charcoal | `warm` | Coral `#ff7a50` | Warmer, the Round 2 default for F. |
| OLED black | `oled` | Violet `#a78bfa` | True-black background, cards outlined instead of shadowed. |
| Light | `light` (and `:root`) | Coral `#c8461a` | E's palette, with the contrast fixes below. |

Each palette sets `color-scheme`, light for Light and dark for the others, so native controls and scrollbars are drawn to match. Every scrollbar, vertical or horizontal, the window's and those of the boxes that scroll (sidebar, both editors, code blocks, wide tables, dialogs, menus), has a thumb of `muted-foreground` at 80% on a transparent track, over the box's own background. The browser darkens the thumb on hover and drag. With forced colours (high contrast) the system's own scrollbars show.

### Contrast

WCAG 2 contrast ratios, computed from `theme.css` with translucent fills composited over `card`. AA requires 4.5:1 for body text and 3:1 for non-text indicators.

| Pair | light | slate | warm | oled |
| --- | --- | --- | --- | --- |
| foreground / card | 14.3 | 14.1 | 14.1 | 17.5 |
| subtle-foreground / card | 5.8 | 7.9 | 7.9 | 9.0 |
| muted-foreground / card | 5.4 | 6.0 | 6.2 | 6.3 |
| muted-foreground / card, hover tint | 4.8 | 4.8 | 4.9 | 5.2 |
| muted-foreground / muted | 4.8 | 5.3 | 5.6 | 5.7 |
| primary-ink / primary-soft | 4.7 | 9.1 | 7.2 | 8.6 |
| primary-foreground / primary | 4.8 | 9.2 | 7.3 | 6.9 |
| status-published fg / bg | 4.7 | 9.7 | 9.7 | 11.2 |
| status-draft fg / bg | 4.6 | 9.5 | 9.1 | 10.8 |
| note fg / bg | 7.9 | 11.1 | 10.6 | 11.6 |
| draft-dot / card (non-text) | 3.2 | 8.1 | 8.1 | 9.0 |
| update-dot / background or card, the lower (non-text) | 4.6 | 6.8 | 6.8 | 7.6 |
| scrollbar thumb / card (non-text) | 3.6 | 4.3 | 4.4 | 4.4 |

The exploration mocks' light palette failed AA in three places. `theme.css` fixes them, so light differs slightly from what was reviewed:

| Token | Mock value | Ratio | Token value | Ratio |
| --- | --- | --- | --- | --- |
| `muted-foreground` on `muted` | `#8a8278` | 3.4 | `#71695f` | 4.8 |
| `primary-foreground` (white) on `primary` | `#f2643d` | 3.2 | `#c8461a` | 4.8 |
| `draft-dot` on white | `#f59e0b` | 2.1 | `#d97706` | 3.2 |

The dark palettes' `muted-foreground` was lightened (slate `#7c8aa3` → `#8a98b0`, warm `#968c82` → `#a39990`, OLED `#85858f` → `#93939c`) so it stays above 4.5:1 on `card` under the hover tint (see Button states). On `muted` under the tint it falls below 4.5:1 in every palette, so keep muted-on-muted text to short labels such as the filter placeholder and count pills, and off controls that tint.

Banner toolbar: worst-case ratio of `glass-foreground` over `glass` composited on each preset's colors and on solid white and black. The dark palettes' `glass` opacity was raised (slate and warm 0.55 → 0.66, OLED 0.50 → 0.62) because the reviewed values fell to about 3.5:1 over a white photo.

| Banner | light | slate | warm | oled |
| --- | --- | --- | --- | --- |
| Sunrise | 10.6 | 6.4 | 6.5 | 7.1 |
| Ocean | 8.4 | 7.1 | 7.2 | 7.9 |
| Meadow | 9.5 | 6.1 | 6.2 | 6.7 |
| Lavender | 9.4 | 6.7 | 6.7 | 7.4 |
| Dusk | 7.5 | 8.9 | 8.9 | 10.1 |
| Stone | 8.3 | 6.5 | 6.6 | 7.3 |
| White image | 14.3 | 5.2 | 5.3 | 5.6 |
| Black image | 6.8 | 16.3 | 17.0 | 19.1 |

## Tokens

Every token, with values per palette, is in [`theme.css`](design/theme.css) and shown as swatches in the reference mock. Names follow shadcn, so generated components (`bg-background`, `text-muted-foreground`, `bg-primary`, `border-input`, `ring-ring`) work unchanged. Note that shadcn's `accent` means hover surface, not brand color; the brand color is `primary`.

WikiStow additions: `subtle-foreground`, `primary-2`, `primary-soft`, `primary-ink`, `strong`, `status-published`, `status-draft`, `draft-dot`, `update-dot`, `note`, `table`, `table-head`, `tree-guide`, `glass`, `folder-{green,orange,blue,pink,purple}`, `cover`, `card-shadow`. Palette-independent: `banner-{sunrise,ocean,meadow,lavender,dusk,stone}`, plus the optional `cover-focal` set per page.

Radii: `rounded-card` 18px, `rounded-tile` 14px, `rounded-control` 12px, `rounded-row` 10px, `rounded-folder` 9px, and `rounded-full` for pills and avatars.

The colours are inlined into the utilities from the palette's variables (`@theme inline`). The radii and the font stack are in a plain `@theme` block, so the utilities read `var(--radius-card)` and `var(--font-sans)`, as they read Tailwind's `--spacing`. A theme plugin changes any of them by setting the variable on `:root` (see the plugin SDK's README, which lists the tokens).

Custom utilities: `bg-cover-band` (paints `--cover`, sized to cover, positioned at `--cover-focal`) and `glass` (translucent toolbar with an 8px backdrop blur).

### Mock variable mapping

`layout-mocks.html` predates the token names. When reading it:

| Mock | Token | Mock | Token |
| --- | --- | --- | --- |
| `--bg` | `background` | `--accent` | `primary` |
| `--card` | `card` | `--accent2` | `primary-2` |
| `--text` | `foreground` | `--accent-soft` | `primary-soft` |
| `--muted` | `muted-foreground` | `--accent-ink` | `primary-ink` |
| `--muted2` | `subtle-foreground` | `--on-accent` | `primary-foreground` |
| `--soft` | `muted` | `--btn` / `--btn-ink` | `strong` / `strong-foreground` |
| `--hover` | `accent` | `--g-bg` / `--g-ink` | `status-published` / `-foreground` |
| `--guide` | `tree-guide` | `--y-bg` / `--y-ink` | `status-draft` / `-foreground` |
| `--shadow` | `card-shadow` | `--note-bg` / `--note-ink` | `note` / `note-foreground` |
| `--th` / `--tbl` | `table-head` / `table` | `--tg` `--to` `--tb` `--tp` `--tv` | `folder-green` `-orange` `-blue` `-pink` `-purple` |
| `--glass` / `--glass-ink` | `glass` / `glass-foreground` | `--cover` | `cover` |

## Typography and icons

- Font stack: `ui-rounded, "SF Pro Rounded", "Nunito Variable", Nunito, "Varela Round", "Segoe UI", system-ui, sans-serif`. Only macOS and iOS have `ui-rounded`, so Linux and the Electron client fall back. Bundle Nunito (SIL Open Font License) as a self-hosted package such as `@fontsource-variable/nunito`, imported once in the shared interface. Every client then renders the same, and the Content Security Policy needs no font host. It registers the family as "Nunito Variable", which `theme.css` lists in the stack.
- Weights: 800 for titles, headings, and folder names; 700 for buttons, pills, and labels; 400 for body text.
- Icons in the mock are 16px line icons with a 1.4 stroke. Use lucide-react, the shadcn default, at `strokeWidth={1.75}`. Rough equivalents: `Search`, `Clock`, `Users`, `Bot`, `Settings`, `Plus`, `Share`, `History`, `ChevronRight`, `Pencil` (Edit), `Star` (in pickers).

## Component mapping

Proposed shadcn/Radix building blocks. Check each against the interaction it needs before adopting.

| Part | Building block |
| --- | --- |
| Space tiles | Button with Tooltip (space name) and an accessible name. Selected state via `aria-current`. |
| Space menu, avatar menu | DropdownMenu |
| Choices (Space, Folder, Move to, Access, code language) | Picker (`components/ui/picker.tsx`), not a native select, whose option list the browser draws in its own colours: a button named "Label: choice", 36px, `rounded-control`, `input` border on `background`, with a `ring` outline while focused, as a native select has, so clicking its label shows it focused, then a DropdownMenu of radio items at least as wide, the choice checked and focused as it opens. Not Radix Select, whose scroll lock injects a `<style>` the CSP refuses. Menus in a dialog render inside it, and a dialog's body scrolls rather than its box, so they aren't cut off at its edge. |
| Rail navigation | Buttons or links with visible labels. |
| Folder tree | No tree primitive in Radix. Build on Collapsible for folders, with the WAI-ARIA tree pattern (`role="tree"`, roving tabindex, arrow keys, Home/End, type-ahead). Wrap in ScrollArea. |
| New page, Edit, Publish, Done | Button (`default`, `secondary`, glass variant). Shown per the [Page views](#page-views) rules. |
| Button states | Every button, menu trigger, tree row, and pill that clicks shares these states. The editor's code language and quote type Pickers keep their own lighter fill instead of the tint. Enabled buttons show they click before they're hovered: a fill (`default`, `secondary`, `destructive`), a border (`outline`), or an underline (`link`). `ghost` relies on its icon, or on its place in a toolbar, a group of choices, or beside a dialog's main action; a text-only action anywhere else is `outline`. Hover layers the palette's `foreground` over the control's own fill (`tint` in `app.css`), and a press layers more (`tint-strong`): 6% and 12% in Light, which keeps `muted-foreground` on `card` above 4.5:1 while hovered, and 9% and 17% in the dark palettes. Over the banner's glass the hover tint is 6% in every palette, which keeps toolbar text above 4.5:1 over a white image. The tint darkens in Light and lightens in the dark palettes, on any surface. The bright `default` and `destructive` fills darken instead in every palette (`shade`: black at 10%, and 18% pressed), which shows on them in the dark palettes and keeps their text above 4.5:1. The `accent` hover surface is the same tint as a fill. A press also nudges a Button down 1px, which a tap shows where there's no hover. Keyboard focus is a 2px `ring` outline, 2px out, except where a control draws its own ring (the formatting toolbar, the editor's mode buttons, inputs). Disabled is half opacity and less saturated, with no shadow. The current page's row, rail item and admin tab, and the status pills, whose colours sit near 4.5:1, take no tint on hover; the pills underline instead. Controls that appear on hover elsewhere stay visible on touch screens. |
| Share and access | Dialog listing the owners, the space's groups that have the folder, then people with their access: Reader, Editor, or Editor + publish, and where it comes from; then agents, read-only, "via" the person they work for. See [Groups](#groups). |
| View-switching pills | Badge rendered as a button, with `aria-pressed` on the current view. |
| Status pills | Badge with WikiStow variants: `published`, `draft`, `neutral`. |
| Avatars | Avatar with initials fallback. |
| Filter field | Input. Search across spaces is a separate command dialog from the rail. |
| History panel | Sheet from the right. |
| Properties box | Collapsible wrapping a plain monospace textarea. Not a form: this version keeps frontmatter as raw text. |
| Formatting toolbar | In the visual editor only, a strip along the top of its box, `border-b` under it, above the area that scrolls, so it stays in view; it wraps on narrow windows. A text style DropdownMenu, then icon buttons (lucide) in groups split by Separators: bold, italic, inline code; quote, code block; bulleted, numbered list; link, which opens a Popover form (Text when inserting, Link to, then Remove link, Cancel and Add link or Save) while the text it works on keeps a `primary-soft` highlight; attachment (paperclip), which opens a DropdownMenu of the page's attachments (an image or file icon, the name, then kind and size in `muted-foreground`), a disabled "No attachments yet" item when there are none, and Upload a file… under a separator. Quote is a split button: the toggle, showing an alert's lucide icon while the cursor is in one, then a 16px chevron opening a DropdownMenu of radio items (Quote, Note, Tip, Important, Warning, Caution, each with its icon), the quote's kind checked. 32px controls in `muted-foreground`, `tint` on hover and `tint-strong` while held, `primary-soft` with `primary-ink` while pressed (`aria-pressed`), half opacity while they don't apply (`aria-disabled`). Tooltips give the name and shortcut. `role="toolbar"` with a roving tabindex. |
| Wikilink autocomplete | Command list in a Popover anchored at the cursor after `[[`: page titles with their folder, then headings after `#`, with a "Create page" option for editors. |
| Banner and emoji pickers | Popover with the preset gradients, an upload button, and a focal-point slider; a separate emoji picker. Both appear only on the draft view. |

## Sharing

Sharing follows the [protocol](protocol.md) sections 6 to 8. Every action is a named command.

- **Share dialog.** Opened from the page's **Share**, a folder's menu (**Share…**), or the space menu (**Share space**). For a folder not shared yet: find a person by their exact email, pick their access, then look over **What will be shared** (the folder and everything under it, by decrypted name) and the history notice (readers get every retained publication; editors also every draft) before **Share**. The dialog refuses a folder holding anything this app can't read. Long shares show how many versions are done. A folder inside a share, or holding one, points to that share: shares don't nest.
- **Export dialog.** Opened from **Export…** in the space menu or a folder's menu; a reader's folder menu holds only that. It says the pages are exported as the person sees them, drafts included for an editor, and that the files aren't encrypted. While it runs it shows the pages opened, then the attachments downloaded, with a bar; closing it stops the export. If some pages couldn't be opened, or attachments downloaded, it says how many of each were left out once the zip has downloaded. An export too large for the browser (more than 65,535 files and folders, or 1 GB of files) is refused before it opens anything it can tell is too much, with a line that points to `wikistow export`.
- **Access list.** Owners first (never a choice), then members with an access picker and a menu: **Remove from this folder** and **Remove from every folder in this space**. Making an editor a reader, and removing someone, show who keeps access, and who doesn't and why, before any keys change. Publish rights change at once. **Add someone** is under the list.
- **Key-change warning.** When a person's key differs from the one pinned, their row shows **Key changed**. The warning replaces the dialog's content until the owner decides: the old and new fingerprints, **Confirm new key**, **Decline new key**, or **Not now**. Nothing seals to the key before it is confirmed. A member confirmed this way waits for keys, and gets **Give access** (see [Groups](#groups)).
- **Members and owners** (`/s/$spaceId/members`): owners with **Add co-owner**, **Transfer**, **Remove** (and **Leave** when another owner remains); each shared folder and its people; and everyone with **Remove from every folder**. Unfinished work shows as banners: an owner removal to finish, or, for a new owner after a transfer, **Renew keys**.
- **New owner.** The first time a new owner opens the space, a dialog names who added them, with that person's fingerprint, to **Confirm** or **Decline**. Declining asks again after the next unlock.
- **After unlocking**, a "Waiting for you" note lists owned spaces with ownership work left, or people waiting for keys.
- **Shared with me** (`/shared`, the rail's **Shared**): each shared folder or space by its own name, who shared it, and the person's access. Opening one shows its tree from the shared folder down.

## Groups

Groups (`wikistow.md`, Milestone 5 Groups) are built, for people and their agents. Only owners see groups; members see no group names anywhere, and Shared with me looks as it does without groups.

- **Groups page** (`/s/$spaceId/groups`). There is no space settings page, so **Groups** sits in the space menu under **Members and owners**, for owners only. Members and owners links to it, and lists each shared folder's groups with their access, and each person's access there through groups too, marked while they wait for keys. The Groups page lists each group by name with how many people and folders it has, its people's labels, and its folders with their access. **New group** asks for a name. A group opens (`/s/$spaceId/groups/$groupId`) to its members by their pinned label, with **Key changed** (the key-change warning), **Waiting for keys** with **Give access**, and **Remove from group**; **Add member** (an exact email, then the group's folders with the access the person gets there and the history notice); its agents, as "agent (for person)", one not confirmed yet marked "Gets nothing until Alex confirms", each with **Remove from group**; **Add agent**, which lists the owner's own agents and those of the group's people with **Add** (the owner's own is confirmed in the same step); the folders it has with their access and **Manage**, which opens the folder's Share dialog where the access changes; **Rename** and **Delete group**. Removing a member and deleting a group show, before any keys change, each folder the group has with what each person is left with there ("Editor · direct", "Reader · via Friends", or "No access"), then each folder that gets new keys with who keeps it and who doesn't.
- **Share dialog.** **Add someone**'s field (labelled "Email or group" once the space has groups) offers the space's groups whose names hold what is typed, as buttons under it, beside finding a person by email; the access picker beside it applies to either. Choosing a group for a folder not shared yet lists its members by label under **Who gets it**, each marked if they would wait and why, with the history notice. For a shared folder it shows each member's access afterwards and where it comes from, who gets the keys now, and who waits. The access list shows groups after the owners, each with an access picker, a menu with **Remove from this folder**, and a disclosure listing its people. A person's row shows where their access comes from under their email: "direct", "via Family", or with each access when there are several ("Editor direct · Reader via Family"). Their picker changes only their direct grant; someone there only through groups shows their access as text, with no picker, and **Add someone** gives them a direct grant. Their menu's **Remove from this folder** becomes **Remove direct access** when they also have group access: it says what they keep, and nothing rotates unless their role drops. While someone waits for keys their picker is off, and **Add someone** turns them away, until **Give access**: so nothing is sealed to them that the owner wasn't shown. Raising a group's access asks first, with the members who get draft keys; lowering it shows the rotation; publish rights alone change at once.
- **Waiting members.** After unlocking, the "Waiting for you" note lists owned spaces where people wait for keys ("people wait for their keys"), with **Give access**. Its dialog lists them by label with each folder they wait for and the access they would get; someone whose key changed shows **Key changed** first. **Give access** on a person shows what they get, and seals once the owner confirms. A member waiting in a share's access list shows **Waiting for keys** and **Give access**, which replaces **Share again** after a key change.
- **Agents.** A person whose agent an owner added to a group is told so in the note after unlocking ("An owner put one of your agents in a group. Confirm or decline it on the Agents page"), and sees it in the agent's card under **Through groups**: "An owner added it to a group in Family. It gets these folders only if you confirm", the folders the group reaches with the access the agent would get (never more than the person's), and **Confirm** or **Decline**. A space whose name the person can't read (they hold only folders of it) is "a space Olive shares folders of with you". A confirmed group shows "Through a group in Family" with its folders and **Take out of group**, which says the agent keeps the keys it had and the folders' owners will be offered new ones. Revoking an agent lists its groups' folders with its picks, for new keys. Removing a person from a group says their agents leave with them; removing an agent shows only the folders that get new keys.

## Publishing to another space

Publication follows the [protocol](protocol.md) section 13. Every action is a named command.

- **Publish to another space…** is in the page menu, for the version in view, draft or published, for someone who can publish the page. Its readers can't copy it elsewhere. The dialog has two steps.
- **Choose.** A **Space** picker (every space but this one: spaces the person holds whole by name, and spaces they hold only folders of by the shared folder's name, marked "a folder shared with you"), then a **Folder** picker listing only where they can edit and publish there.
- **Confirm.** Focus moves to the "To Space › Folder." line, or "To the page it was published to before, in …" when this page already has a copy in that space, which stays where it is. It shows:
  - **At least these people can read it there**: for an owner of that space, everyone their app verified holding the folder's keys, and the owners; for anyone else, the owners and themselves, with "and anyone else it's shared with there: only an owner of … can see who". The server could hide someone, so it is a lower bound.
  - **Attachments that go**, each with a checkbox, ticked by default. Each goes copied and encrypted afresh.
  - **Links readers there may not be able to open**: the pages wikilinks name (a link to a heading of this page aside), and pages in other spaces it links to, as plain text, each once, with how many links point at it when more than one does. Linked pages are never published with it.
  - The **Copies can't be recalled** note, then **Back** and **Publish there**.
  A change there meanwhile (someone published, or access changed) shows the preview again with "Something changed there meanwhile", and sends nothing.
  When the page already has a copy in that space somewhere the person can't publish, the step says so instead, with **End the existing copy there**: the copy stays where it is, as a page of its own, and the person can then publish there.
- **Done.** "Published. Readers there see it now.", with **Open it there** and **Close**.
- **The copy** shows the ↗ pill. Later changes to the source reach it only when someone publishes to it again; its history holds only what was sent. Readers there can't open the source, and the source's readers can't open the copy.
- **Unpublish…** works on a copy as on any page. Its editors then see its last publication with an ✎ Unpublished pill, and its publishers still get **Detach to edit…** and **Move…**. Readers see it again once its source is published to it again (while it is still that page's copy), or once someone detaches it and publishes it. Unpublishing a page leaves its copies in other spaces as they are, and its dialog says so.
- **Detach to edit…** (publishers of the copy) asks first: it becomes a page of its own, its draft starts from its latest published version, and nobody can publish to it from the source any more; publishing the source there again makes a new page. Editors who can't publish see a note saying a publisher can detach it.

## Agents

Agents follow the [protocol](protocol.md) section 9. Every action is a named command, and only a person manages their own agents.

- **Agents page** (`/agents`, the rail's **Agents**): each agent the person enrolled, live or revoked, by the name in their own contacts record, with when it was enrolled and when it last wrote, and what it can reach. Each pick shows its access, which the person can change or take away; **Add a folder** adds one. A pick the server lists but the person's record doesn't back shows **Confirm**, since their apps seal only what the record lists. **Through groups** lists the groups owners put the agent in (see [Groups](#groups)).
- **Add an agent.** The person enters the lookup code `wikistow agent enroll` shows, behind a recent sign-in (case, spaces and look-alike letters don't matter). The dialog then shows the enrollment fingerprint large, in the CLI's ten groups of four, and waits for the CLI's user to confirm theirs. Meanwhile the person names the agent and picks what it can reach: a space, a place in it, and access up to their own, with publish only where they can publish. Names are unique among the person's agents; a revoked agent holding the name is renamed out of the way, and the dialog says so. A place in the owner region of a space they own is marked as becoming a share, with the agent its only member besides the owners. **Fingerprints match, approve** works once the CLI has confirmed, and shows each step while it seals. **They don't match** turns the enrollment down, as closing the dialog does.
- **Add a chat assistant** (here, and from the page chat, when the server has AI): the same dialog without the code or fingerprint, since the app enrolls the assistant itself. The person names it and picks what it can reach, then **Add assistant** creates it behind a recent sign-in.
- **Revoke.** The dialog says what it means first: the credential stops working at once, but keys the agent already holds stay with it. Afterwards it lists the folders the agent could read. One in a space the person owns offers **Rotate keys**; the owners of any other are offered it.
- **At every unlock**, and after any change to access, the app seals to the person's agents the key versions they lack. The "Waiting for you" note says when that failed, or when a pick needs confirming.
- **Attribution.** History names an agent's publication as "agent (for person)": the person's own name for their own agent, or for someone else's agent the server's name for it, in quotes, with the person it acts for. Editors see the **🤖 agent · time** pill and the sidebar's **Agent activity** card; readers see neither.
- **Owners** see agents in the Share dialog and on **Members and owners**, read-only, "via" their person. An agent that no longer has access but still holds a folder's current keys offers **Rotate keys** there, and the "Waiting for you" note lists its space.
- **Administration.** **Revoke sessions and agents** asks first, saying the person is signed out everywhere and every agent they enrolled stops working for good.

## Page chat

**Assistant** in a page's toolbar, when the server has AI, opens the chat: a 380px card after the page card on windows 1200px and wider, otherwise a sheet from the right, the whole width on phones. The sheet covers the page; closing it keeps the conversation. It stays open, with its conversation, from page to page until it is closed, and locking ends it.

- **Choosing.** With no chat yet, a picker of the person's chat assistants and **Start a conversation**, **Add an assistant**, and the AI disclosure.
- **Header.** The assistant's name, the model and the provider's host, **New conversation**, where it works and its access there ("Works in Kitchen (editor)"), and, once it has changed something, **Changed:** with a link to each page.
- **Messages.** The person's messages on the right in `primary`; the assistant's as plain text, never rendered Markdown or links, with a muted line per tool it ran (✓, ✕ with the reason, or … while it runs). Below them, **Pages it looked at**, each a link.
- **Context.** Above the message box, the page on screen as a chip, **Include "Title"**, pressed while it is to go with the next message. It is never pressed by itself: moving to another page offers that page instead, and a message clears it. A sent message shows **Included "Title"** above it.
- **Proposals.** Each is a bordered card, numbered, with what it does, the assistant's one-line reason, and exactly what approving does: where it goes, the new page's text, or for an edit a line diff of the draft (folded around changes). **Approve** and **Reject**; with more than one waiting, **Approve all N**, which says each is made on its own. Its state pill: Waiting for you, Applying…, Applied (`published` colours), Rejected, Not applied (with why), Dropped (after revocation, or when Stop cut short the step that made it).
- **Stop** replaces **Send** while a reply is written or approved proposals are being made. A stopped reply says so, and that approved changes stay made.
- **Revoked.** The chat says the assistant can't read or change anything now, its proposals were dropped, and what it sent to the provider can't be recalled. The message box is off.

## Plugins in Settings

Settings → Plugins lists what is installed first, one bordered row per plugin: its name, version and trust level badge with an on/off switch, its description, any problem in the destructive colour, **Remove** (and **Reload** for a development folder on the desktop), then **Page access** when its manifest asks for any. The desktop app adds **Install plugin…**, **Load development folder…** and **Build one with the assistant** above the list, and **Share to library…** on each plugin installed from a folder, which asks first, saying everyone on the server can see and install it and only the account that first shared its ID adds versions. A file name the library refuses is named in the destructive colour, before anything is sent.

In the browser the plugins come from the server's library. The desktop app shows the same below its folder installs, once the vault is open, with the installed ones under **Installed from the library**; there a plugin whose copy couldn't be installed says why, such as files that don't match the version approved, a folder install of the same ID adds a muted line saying it replaces the library's here, in place of the library row's page access, and the library has no upload button but a line saying to share an installed plugin or a workshop version. An installed plugin with a newer version in the library says so under its description, with **Update…**; one whose version left the library says it no longer loads, with **Install** for the newest version if there is one, and **Remove**. Below is **Library**, with **Upload plugin folder…** on a computer (a phone says uploading needs a computer), and a row per plugin: name, newest version, trust level, **Installed** if it is, description, what it asks for and who uploaded it, **Install…**, **Remove from library** for its owner or an admin, and a collapsed list of its versions with date, size, hash and **Remove version**. Removing from the library asks first, saying it goes for everyone. While the vault is locked the section only says to unlock it.

Install and Update open the approval dialog: the plugin's name and version as the title, its description, the trust level badge with what that level may do, the page access it asks for, for an update what it replaces and whether the level or access changes (in bold), and the SHA-256 approved. Its button says **Install**, **Update** or **Load**.

Safe mode shows a small card at the bottom right, drawn by the app: "Safe mode: plugins are off.", **Manage plugins** and **Turn plugins back on**. In the browser the unlock page has **Open without plugins** under **Unlock**.

## Plugin workshop

Desktop only, at `/workshop`, reached by **Build one with the assistant** in Settings → Plugins or **Build a plugin** in the assistant's panel; neither shows in safe mode, where the page says plugins are off. The main card is the preview; the conversation is the assistant's column beside it (a sheet below 1200px), and stays open from page to page like the page chat.

- **Starting.** What the workshop does, the workshop's disclosure (messages, the plugin's files, its sample pages and what the preview shows go to the provider; no page goes unless copied in), and **Start a workshop**. Starting one ends a page chat.
- **Conversation.** As the page chat's: plain text, a muted line per tool, **Stop**. Its header says **Plugin workshop**, the model and host, **Open the preview** away from it, and **End workshop**. The chip above the message box is **Copy "Title" into the preview** for the page on screen, which copies its draft where the person edits it, else the publication; pressed, it reads **Copied**, and the next message says so.
- **Status.** **Previewing vN**, the plugin's name, version and trust level, and **Unload**; **Building…** while one runs. A build that failed shows as an alert: "vN didn't build. The preview still shows vM, the last version that did." (just "still shows vM" when an older one was picked), with each error's file, line and message.
- **Consent.** A version with app code shows an alert saying it would run inside WikiStow with the person's trust, with **Run its app code in this workshop**; once allowed, a muted line with **Stop running it**.
- **Problems.** The plugin's runtime problems and errors from its code, in a destructive alert.
- **Theme across the app.** For a version with themes: **Not shown** and one button per theme, pressed while shown, with a note that nothing is chosen until it is installed and picked in Settings.
- **Sample pages.** A button per sample and **New sample**, then the sample as a page card: a toolbar with "Sample page" or "A copy of "Title"", **Editor** and **Reader**, the plugin's toolbar views and its **Plugins** menu; its header views, title, text (the visual editor or the reader), footer views, and its asides beside it.
- **Its other places.** Its rail items as a line of text, and a button per plugin page and settings section, which draws it below.
- **Versions.** Newest first: **vN**, name and version or **Didn't build**, **In the preview**, the SHA-256, and **Preview**, **Export…**, **Install…** and **Share to library…** for one that built. Install opens Settings' approval dialog, which shows the hash; Share asks first, as in Settings.
- **Workspace files.** A button per file, showing its text below.

## Lock when idle

A Settings section after Two-factor sign-in, saying the vault locks after the chosen time with nobody using WikiStow, that typing is saved first, and that the choice stays on this browser (or computer, in the desktop app). Its one control is a **Lock after** Picker of Off (the default), 5 minutes, 15 minutes, 30 minutes and 1 hour. An idle lock leaves for the unlock page the way **Lock vault** does; Settings and admin pages stay where they are, locked.

## Restore notice

After an operator restores a backup, a device that used the server before shows "This server was restored from a backup taken on <date and time>. Changes made after that are gone." (or, when the backup's time is unknown, when it was restored) in a dialog titled **Restored from a backup** with an **OK** button, so it hides none of the notices in the bottom right corner (Waiting for you, the desktop's safe mode). It opens on any page behind sign-in, once per restore: closing it any way counts as seen. The last restore seen is kept per installation in `localStorage` (`shell/restore-notice.tsx`), in the browser and the desktop app alike; a device meeting the server first keeps it without a notice.

## Narrow screens

Chosen 2026-10-02: **I, Drawer**, picked because it matches the desktop layout. Below about 900px:

- **Top bar** (52px): menu button, space tile and name, search button, account avatar. In the desktop app, the menu button carries the avatar's `update-dot` and "update available" in its label while a newer release is out.
- **Drawer**: slides in from the left over a dimmed page, about 92% of the screen width. It holds the desktop rail (space tiles, labeled navigation, Settings, avatar) beside the sidebar card (space header, New page, filter, folder tree). These reuse the desktop components. Tapping a page or the dimmed area closes it.
- **Page card**: full width with an 8px margin. The cover band is 104px, the emoji badge 56px, and the body padding 32px 18px. The table of contents is a collapsed **On this page** disclosure above the body.
- **Cover toolbar**: the same actions as desktop. To fit, the breadcrumb shows only the folder, and Assistant, History and Share become 30px icon buttons. The published view shows **Edit**; the draft view shows **Done** and **Publish**. Banner and emoji editing move into a menu on the draft view if the toolbar runs out of room.
- **Pills and view rules** are unchanged from [Page views](#page-views).

Known tradeoff: Publish sits at the top of the screen, out of easy thumb reach. That's accepted for consistency with desktop. If it proves awkward, L's floating Publish button can be added to the draft view without changing navigation.

The alternatives (J, Tab bar; K, Dock + sheet; L, Floating button) remain in [layout-mocks.html](layout-mocks.html), Round 4.

## Import

WikiStow has no importer, in the interface or the CLI. Moving an Obsidian note means pasting its Markdown into a page, or having an agent push it with the CLI. See the implementation spec's editor section.

## Open items

None.

### Resolved 2026-10-01

- Reaching the published version and Access: see [Page views](#page-views). Pages open on the published version, editing happens in the draft view, and Access lives in Share.
- Light theme accent: each palette keeps its own accent.
- Theme preference scope: synced to the account.
- Cover band per page: pages choose a theme, preset, or uploaded-image banner, plus an optional emoji. See [Banners and page emoji](#banners-and-page-emoji).
- Folder defaults: ⭐ on the blue tint.
- Import button: removed from the sidebar.

### Resolved 2026-10-02

- Phone layout: I, Drawer. See [Narrow screens](#narrow-screens).
- Banner presets: Sunrise, Ocean, Meadow, Lavender, Dusk, Stone.
- Obsidian import: dropped. Notes move by paste or agent push.
