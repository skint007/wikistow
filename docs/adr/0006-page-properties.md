---
status: accepted
---

# Page properties: rows, values in the page, tag search and query tables

People want a page's frontmatter as fields rather than raw YAML, and want to show its values in the page, other pages' too, to find pages by tag, and to list pages by their properties. The spec keeps frontmatter as opaque text, and lists "structured page properties (editable property fields, tag browsing, and metadata queries)" as later work. This ADR is that work. It settles how WikiStow reads the YAML, how it changes it without rewriting it, the syntax for a value in the page, where values come from, and what a public link shows. It amends ADR 0005 (decision 1).

In short:
- Properties show as typed rows above the body, edited in place. An edit changes only that value's characters in the YAML.
- `` `=key` `` shows one of the page's values, and `` `=[[Page]].key` `` another page's.
- Search takes `tag:` and `key:value` filters.
- A `wikistow-query` code block lists pages as a table, and a folder can open as a table of its pages' properties.
- A public link's copy writes the values in as plain text.

## What the code supports today

- **Frontmatter is split off before anything parses the body** (`splitFrontmatter` in `packages/client/src/markdown/frontmatter.ts`) and joined back unchanged (`joinPage` in `packages/ui/src/page/properties.ts`). `PropertiesBox` shows the text between the delimiters read-only. On the draft view, `PropertiesEditor` gives a textarea that changes only that text (`withProperties`). No YAML library is in the tree.
- **Wikilinks are found in the body only** (`placedWikilinks` in `packages/client/src/links.ts`). Each revision's encrypted link table (`wikistow.links`, `packages/client/src/link-table.ts`) maps a link's folded target text to a page ID, for pages everyone who can open that version can open. A rename rewrites the link's text the next time an editor saves the linking page.
- **Inline code is plain Markdown that every reader keeps**: an `inlineCode` mark in the visual editor, which the fidelity check compares like any other.
- **Search is a client index** (`SearchIndex` in `packages/client/src/search.ts`) of each page's title and reduced text, with frontmatter kept as plain text. Readers index published versions, editors drafts. The desktop app keeps it sealed between launches, bound to the app build.
- **A public link's copy is the published body without its frontmatter** (`shareCopy` in `packages/client/src/operations/public-links.ts`), rendered by the server. ADR 0005 says that keeps properties encrypted.
- **Template variables use `{{name}}`**, in titles, bodies and properties, and are filled once, when a page is made from a template.
- **Folders have no view of their own.** Clicking one opens or closes it in the sidebar.

## Decisions

### 1. Frontmatter has meaning

The block is read as YAML 1.2 with the `yaml` package, which keeps every node's place in the source. Its **properties** are the top-level keys of a map. The spec's "No meaning in this version" rule goes. The block is still split off before either editor sees the body, still kept in the page's Markdown, and export still writes it as stored.

A block whose top level isn't a map, or that doesn't read as YAML, shows as text with one line saying why. Each value is shown as a row only if it is a scalar or a list of scalars. Any other value (a nested map, for one) shows as its source text, read-only, with **Edit as text**.

### 2. Types come from the values

No schema is stored anywhere. A value's type is what it reads as:

- a list;
- a number;
- `true` or `false`;
- a date (`YYYY-MM-DD`, or with a time);
- a web address (`http`, `https`);
- one wikilink alone (`"[[Page]]"`, as Obsidian writes them);
- otherwise text.

Keys show in sentence case (`cook_time` reads "Cook time") and are written as typed. A row's **Type** changes only how the value is written, for instance quoting `"35"` to keep it text.

Considered: a list of keys and types per space or folder. It is more setup, and pages arriving from Obsidian would need it filled in before they showed well. **Add property** suggests the keys that pages in the same folder use, and a template's properties already give a new page its keys, so suggestions and templates do what a schema would.

### 3. Changing a value changes only its characters

An edit through the rows, a table cell or a rename takes the edited value's range in the source and replaces only those characters. Everything else stays byte for byte as it was: comments, quoting, flow or block lists, key order, line breaks. A new key is a line added at the block's end, in its indentation and line breaks. Removing a key removes its lines. A value that can't be replaced safely that way is read-only in the rows and opens **Edit as text**: a multi-line or folded scalar, an anchor or alias, or a value with a comment inside it. The textarea always works.

So the spec's promise becomes: frontmatter changes only where a person changes it, through the rows or the text, or where a renamed link's text follows its page (decision 5).

Considered:
- **Writing the whole block again from the parsed values.** It is simpler, but it drops comments and rewrites quoting and list style, so one edited number shows in history as every line changed. Notes from Obsidian carry comments and styles people chose.
- **Read-only rows,** editing only through the text. It never rewrites anything, but loses editing in place.

### 4. A value in the page is inline code starting with `=`

`` `=servings` `` shows this page's `servings` value. Dataview's form, `` `= this.servings` ``, means the same, so notes move between Obsidian and WikiStow both ways. A name follows the template-variable rule (a letter or digit, then letters, digits, combining marks, spaces, `_` and `-`). It matches a key whatever its case, with `_`, `-` and spaces counting as the same, so `` `=cook time` `` finds `cook_time`, and an accent typed apart from its letter (NFD) the same as one typed with it (NFC). If two keys match, the first in the block wins.

How values show:
- A list shows comma-separated, a date in the reader's locale, a wikilink as a link chip.
- The reader shows a value with a dotted underline and a hint naming the property. It never makes HTML from a value, only text or a link chip.
- The visual editor keeps the inline code as it is, and a decoration shows the name and the current value, so the document and the fidelity check don't change.
- An unknown name shows as written: for editors with a dashed underline and a hint, for readers as inert monospace text.

Considered:
- **`{{servings}}`.** Templates already ask for every `{{name}}` when a page is made, so a template holding a reference would ask for a value.
- **`[[#servings]]`.** That already links to a heading on the same page.
- **`<prop name="servings">`.** Raw HTML is an inert atom in the visual editor and would need its own sanitizer exception.

Inline code is kept by every Markdown tool and needs no new parser. Its cost: real code starting with `=` and a name, such as `` `=total` ``, reads as a reference. The name rule keeps `` `=SUM(A1:A3)` `` code, and an unknown name shows as written.

### 5. Other pages' values, and wikilinks in properties

`` `=[[Garlic bread]].cook_time` `` shows a value from another page. The `[[…]]` resolves as a wikilink does, and goes in the link table like one, so it follows a rename, and its text is updated the next time an editor saves.

The value comes from the version of that page the viewer's search index holds: the published version for its readers, the draft for its editors. A reader who can't open the page sees the text as written, whether the page is missing, unpublished or outside their access, so nothing shows whether it exists.

A property whose value is one wikilink goes in the link table too, and follows renames the same way, through decision 3. It is the one change the app makes to frontmatter by itself. Wikilinks inside a longer value stay text.

### 6. Tag and property search

The index keeps each page's parsed properties beside its text, for the version it already holds. Search takes filters:

- `tag:soup` matches a `tags` list holding `soup`, or `tags: soup`, whatever its case.
- `key:value` matches a scalar equal to the value, or a list holding it. Keys match as names do in decision 4, and quotes allow spaces: `status:"in progress"`.
- Filters and words must all match.

Tag pills in the rows link to that search. A desktop index kept from an older build already opens as nothing and is rebuilt.

### 7. Query tables

A fenced code block labelled `wikistow-query` lists pages:

- `from`: a folder path in this space, or `#tag`. Left out, the whole space.
- `where`: conditions joined by commas, all of which must hold, with `=`, `!=`, `<`, `<=`, `>`, `>=` and `has`. Numbers and dates compare as such, and text compares only for equality, whatever its case.
- `show`: the columns.
- `sort`: a key or `title`, then `asc` or `desc`.
- `limit`: at most 500, 100 by default.

It runs in the viewer's app over their index, so it shows only pages that person can open, in the versions search shows them, and two readers can see different rows. The table updates as the index does. While the index is still building, the table says so.

A block that doesn't read shows as code with a line saying what's wrong. The visual editor keeps the block as code and shows the table under it. Export, agents and Obsidian see the fenced code as written.

The language is deliberately small, and not Dataview's: a Dataview query block stays code.

### 8. The folder table view

A folder opens to a view of the pages directly in it, as a list or a table, with the choice kept on the device per folder. The table's columns are the title, then the keys its pages use, in the order they first appear, and columns can be hidden. Readers see published values. Editors see what search shows them, and editing a cell saves that page's draft through decision 3, against the revision it read: a conflict shows on the cell, and nothing is overwritten. A page without frontmatter gets a block when a cell on it is first filled.

### 9. Public links write the values in

A public link's copy keeps leaving the frontmatter out. It now writes in what the body shows of it, as plain text Markdown, before the copy goes up:

- A reference to this page's value becomes the value.
- A reference to another page's value becomes the value from that page's **published** version. A draft never goes into a copy, even when the person publishing can edit that page. A reference that doesn't resolve stays as written.
- A query table becomes a Markdown table as it stood at publish, from published versions only. A page in it is a wikilink only if it has a public link of its own (ADR 0005, decision 6), otherwise its title as text.

So the server now holds, readable, the property values a public page's body shows, from that page and from others. This amends ADR 0005, decision 1, whose copy kept properties encrypted.

When the page shows values from other pages or holds a query table, the public link dialog and the Publish confirmation say so. Values from other pages are as they were at the last publish, until the page is published again.

## Consequences

- The spec's Frontmatter, Wikilinks, Search, Public links and Export sections change, as does the later-work line and `ui-design.md`'s Properties rows. The glossary gains **Property**, **Property reference** and **Query table**.
- The client gains the `yaml` package.
- Search's index format changes. The browser's lives in memory, and the desktop's is bound to the build, so neither needs a migration.
- The server changes in nothing: it renders the copy's Markdown as before.
- A page's frontmatter can now change through the UI, so history shows small edits in it.
- Agents, the CLI and plugins keep reading and writing the Markdown as is.

## Decided (2026-10-25)

Scott chose the direction on 2026-10-25, from three mocked designs. He chose A's property rows, B's references to other pages' values, and C's tag search and query tables, plus C's folder table view. He also chose:
- changing only the edited value's characters, over writing the block again or read-only rows;
- types read from values;
- public copies with values written in, other pages' and query tables included.

## Implementation, in pull requests

1. **This ADR and the spec.**
2. **Property rows and this page's values** (#173): YAML reading and value-only edits, the rows, `` `=key` `` in the reader and the visual editor, completion, and public copies.
3. **Other pages' values** (#174): `` `=[[Page]].key` ``, wikilinks in properties, the link table and renames.
4. **Tag and property search** (#175).
5. **Query tables** (#176), after #175.
6. **The folder table view** (#177), after #175.

Steps 3 to 6 each need step 2 only, apart from the two noted.
