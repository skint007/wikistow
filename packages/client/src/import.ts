// Import from Joplin (wikistow.md, Import): its two export formats read
// into notebooks, notes and resources, and each note's links found and
// rewritten for WikiStow. This part is pure; `operations/import.ts` makes
// the folders and pages.
//
// - Markdown + Front Matter: notebooks as folders, notes as `.md` files
//   (`.html` for HTML notes) with front matter, files in `_resources/`.
//   Links between notes are relative paths, `../Home/README.md`.
// - JEX, a tar of Joplin's raw items, `<id>.md` each: the title, the body,
//   then `key: value` lines, and the files in `resources/`. Links are
//   `:/<id>`. Its notes get the front matter the Markdown export writes.
import type { Nodes } from 'mdast';
import { parse, stringify } from 'yaml';
import { cleanPath, macOsExtra, type ImportFile } from './import-archive.ts';
import { foldTitle, resolveWikilinks, type LinkablePage, type PageIndex } from './links.ts';
import { linkSpans, markdownText, parseMarkdown, splitFrontmatter } from './markdown/index.ts';

/** Which of Joplin's export formats an export is. */
export type JoplinFormat = 'markdown' | 'jex';

/** A notebook, by its key: its path in a Markdown export, its ID in a JEX. */
export type JoplinNotebook = { key: string; parent: string | null; name: string };

/**
 * A note: its key, as for a notebook, its Markdown with front matter, and
 * where it is in the export: its file in a Markdown export, its notebooks
 * and title in a JEX.
 */
export type JoplinNote = {
  key: string;
  parent: string | null;
  title: string;
  path: string;
  markdown: string;
  /** An HTML note, its body raw HTML: no Markdown link in it is read. */
  html: boolean;
};

/** A file notes link to, by its key: its path, or its ID in a JEX. */
export type JoplinResource = {
  key: string;
  name: string;
  mediaType: string;
  /** Null when the export has no file for it, or only an encrypted one. */
  file: ImportFile | null;
};

/** Why a note isn't imported. */
export type JoplinSkipReason = 'encrypted' | 'too-large';

/** What a link in a note names: another note or a resource, by key. */
export type JoplinTarget = { kind: 'note' | 'resource'; key: string };

/** A Joplin export, read. */
export type JoplinExport = {
  format: JoplinFormat;
  /** Parents before their notebooks. */
  notebooks: JoplinNotebook[];
  notes: JoplinNote[];
  resources: ReadonlyMap<string, JoplinResource>;
  /** Encrypted items in a JEX, which Joplin must decrypt before exporting. */
  encrypted: number;
  /** Encrypted notes, by where they are in the export. */
  encryptedNotes: string[];
  /** What `url` in `note` names, or null for a link that isn't the export's own. */
  target: (note: JoplinNote, url: string) => JoplinTarget | 'missing' | null;
};

/** The extension namespace naming what an imported folder or page came from. */
export const IMPORT_NAMESPACE = 'wikistow.import';

/** What `wikistow.import` holds: where it came from, and its key there. */
export type ImportMark = { from: 'joplin'; key: string };

/** The extension a folder or page imported with `key` gets. */
export const importMark = (key: string): Record<string, ImportMark> => ({
  [IMPORT_NAMESPACE]: { from: 'joplin', key },
});

/** The key `extensions` marks an import with, if it has one. */
export function importKeyOf(extensions: Readonly<Record<string, unknown>>): string | null {
  const mark = extensions[IMPORT_NAMESPACE];
  if (typeof mark !== 'object' || mark === null || !('key' in mark) || !('from' in mark)) {
    return null;
  }
  return mark.from === 'joplin' && typeof mark.key === 'string' ? mark.key : null;
}

/** A Markdown export's attachment folder; a JEX's. */
const MD_RESOURCES = '_resources';
const JEX_RESOURCES = 'resources';
const JEX_ITEM = /^([0-9a-zA-Z]{32})\.md$/;

/** Media types by extension, for a Markdown export, which doesn't say. */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

const mediaTypeOf = (name: string) =>
  MEDIA_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

const decoder = new TextDecoder();
const textOf = async (file: ImportFile) => decoder.decode(await file.read());

/**
 * `files` as a Joplin export: a JEX if its top holds Joplin's raw items
 * (`<id>.md`), else a Markdown + Front Matter export.
 */
export async function readJoplinExport(files: readonly ImportFile[]): Promise<JoplinExport> {
  const jex = files.some((file) => JEX_ITEM.test(file.path));
  return jex ? readJex(files) : readMarkdownExport(files);
}

// ---- Markdown + Front Matter ----

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

async function readMarkdownExport(files: readonly ImportFile[]): Promise<JoplinExport> {
  const resources = new Map<string, JoplinResource>();
  const notes: JoplinNote[] = [];
  const dirs = new Set<string>();
  for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
    if (macOsExtra(file.path)) continue;
    if (file.path.startsWith(`${MD_RESOURCES}/`)) {
      const name = nameOf(file.path);
      resources.set(file.path, { key: file.path, name, mediaType: mediaTypeOf(name), file });
      continue;
    }
    const html = /\.html$/i.test(file.path);
    if (!html && !/\.md$/i.test(file.path)) continue;
    for (let dir = dirOf(file.path); dir !== ''; dir = dirOf(dir)) dirs.add(dir);
    const text = await textOf(file);
    const { frontmatter, body } = splitFrontmatter(text);
    const markdown = html ? `${frontmatter ?? ''}${htmlBlock(body)}` : text;
    const parent = dirOf(file.path);
    notes.push({
      key: file.path,
      parent: parent === '' ? null : parent,
      title: frontmatterTitle(markdown) ?? nameOf(file.path).replace(/\.(md|html)$/i, ''),
      path: file.path,
      markdown,
      html,
    });
  }
  // Sorted, a folder's path comes before those inside it.
  const notebooks = [...dirs].sort(compare).map((dir) => {
    const parent = dirOf(dir);
    return { key: dir, parent: parent === '' ? null : parent, name: nameOf(dir) };
  });
  const byPath = new Set(notes.map((note) => note.path));
  return {
    format: 'markdown',
    notebooks,
    notes,
    resources,
    encrypted: 0,
    encryptedNotes: [],
    target: (note, url) => {
      // Joplin writes a link to a deleted note as its ID, and to one it
      // didn't export, such as one in its trash, as `undefined`.
      if (/^:\/[0-9a-zA-Z]{32}\b/.test(url)) return 'missing';
      if (SCHEME.test(url) || url.startsWith('#') || url.startsWith('/')) return null;
      if (/(?:^|\/)undefined$/.test(url.replace(/[?#].*$/s, ''))) return 'missing';
      const path = cleanPath(`${dirOf(note.path)}/${unescapeLinkUrl(url.replace(/[?#].*$/s, ''))}`);
      if (path === null) return null;
      if (byPath.has(path)) return { kind: 'note', key: path };
      if (resources.has(path)) return { kind: 'resource', key: path };
      // A link that looks like one of the export's own, to something it doesn't have.
      return path.startsWith(`${MD_RESOURCES}/`) || /\.(md|html)$/i.test(path) ? 'missing' : null;
    },
  };
}

/**
 * A link's path as Joplin wrote it (`markdownUtils.unescapeLinkUrl`): it
 * encodes only spaces and parentheses, and keeps a `%` in a name as it is.
 */
const unescapeLinkUrl = (url: string) =>
  url.replace(/%20/g, ' ').replace(/%28/g, '(').replace(/%29/g, ')');

/**
 * The `title` the front matter gives, read as Joplin reads it, every value
 * text (YAML's failsafe schema), so `title: 1.10` stays `1.10`.
 */
function frontmatterTitle(markdown: string): string | null {
  const { frontmatter } = splitFrontmatter(markdown);
  if (frontmatter === null) return null;
  const inner = frontmatter.replace(/^---\r?\n/, '').replace(/^(?:---|\.\.\.)\r?\n?$/m, '');
  let read: unknown;
  try {
    read = parse(inner, { schema: 'failsafe' });
  } catch {
    return null;
  }
  const title =
    typeof read === 'object' && read !== null && 'title' in read ? read.title : undefined;
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
}

/**
 * An HTML note's body as one Markdown HTML block, which the reader renders
 * as HTML: without the blank lines that would end it, or the indentation
 * that would make what follows a code block. Inside `<pre>` lines keep
 * their indentation, and a blank one becomes an empty `<span>`, which shows
 * the same there. Its `<style>` and `<script>` elements go: the reader
 * shows them as text, and a clip of a complete page starts with the
 * site's stylesheet.
 */
export function htmlBlock(html: string): string {
  const last = (pattern: RegExp, text: string) =>
    Math.max(-1, ...Array.from(text.matchAll(pattern), (match) => match.index));
  let inPre = false;
  const lines: string[] = [];
  const unstyled = html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const line of unstyled.split('\n')) {
    const blank = line.trim() === '';
    if (!inPre && blank) continue;
    const text = inPre ? (blank ? '<span></span>' : line) : line.trimStart();
    const open = last(/<pre\b/gi, text);
    const close = last(/<\/pre\s*>/gi, text);
    inPre = open > close || (inPre && close < 0);
    lines.push(text);
  }
  return lines.join('\n');
}

// ---- JEX ----

/** A raw Joplin item: its title, its body (a note's), and its properties. */
type JoplinItem = { title: string; body: string; props: Map<string, string> };

/**
 * One item as Joplin's `BaseItem.unserialize` reads it: `key: value`
 * lines from the end up to the first empty one, and before them the title,
 * an empty line, and the body. Values have `\n` and `\r` escaped.
 */
export function parseJoplinItem(text: string): JoplinItem | null {
  const lines = text.split('\n');
  const props = new Map<string, string>();
  let i = lines.length - 1;
  for (; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line === '') break;
    const colon = line.indexOf(':');
    if (colon < 0) return null;
    props.set(line.slice(0, colon).trim(), unescapeValue(line.slice(colon + 1).trim()));
  }
  if (!props.has('type_')) return null;
  const rest = lines.slice(0, Math.max(0, i));
  return { title: rest[0] ?? '', body: rest.slice(2).join('\n'), props };
}

const unescapeValue = (value: string) =>
  value.replace(/\\(\\[nr]|[nr])/g, (_whole, escaped: string) =>
    escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped,
  );

const TYPE = { note: '1', folder: '2', resource: '4', tag: '5', noteTag: '6' } as const;

async function readJex(files: readonly ImportFile[]): Promise<JoplinExport> {
  const items = new Map<string, JoplinItem & { path: string }>();
  for (const file of files) {
    if (!JEX_ITEM.test(file.path)) continue;
    const item = parseJoplinItem(await textOf(file));
    if (item) items.set(item.props.get('id') ?? file.path, { ...item, path: file.path });
  }
  const blobs = new Map<string, ImportFile>();
  for (const file of files) {
    const match = /^resources\/([0-9a-zA-Z]{32})(?:\.[^/]*)?$/.exec(file.path);
    if (match?.[1] && file.path.startsWith(`${JEX_RESOURCES}/`)) blobs.set(match[1], file);
  }
  const of = (type: string) =>
    [...items].filter(
      ([, item]) =>
        item.props.get('type_') === type && (item.props.get('deleted_time') ?? '0') === '0',
    );
  const encrypted = (item: JoplinItem) => item.props.get('encryption_applied') === '1';
  const tags = new Map(
    of(TYPE.tag)
      .filter(([, t]) => !encrypted(t))
      .map(([id, t]) => [id, t.title]),
  );
  const noteTags = new Map<string, string[]>();
  for (const [, link] of of(TYPE.noteTag)) {
    const note = link.props.get('note_id');
    const tag = tags.get(link.props.get('tag_id') ?? '');
    if (!note || tag === undefined) continue;
    noteTags.set(note, [...(noteTags.get(note) ?? []), tag]);
  }
  const folders = of(TYPE.folder).filter(([, folder]) => !encrypted(folder));
  const folderIds = new Set(folders.map(([id]) => id));
  const parentOf = (item: JoplinItem) => {
    const parent = item.props.get('parent_id') ?? '';
    return folderIds.has(parent) ? parent : null;
  };
  const resources = new Map<string, JoplinResource>();
  for (const [id, item] of of(TYPE.resource)) {
    const ext = item.props.get('file_extension') ?? '';
    const name = encrypted(item) ? '' : item.title || (ext ? `${id}.${ext}` : id);
    const usable = !encrypted(item) && item.props.get('encryption_blob_encrypted') !== '1';
    resources.set(id, {
      key: id,
      name: name || id,
      mediaType: item.props.get('mime') || mediaTypeOf(name),
      file: usable ? (blobs.get(id) ?? null) : null,
    });
  }
  const notebooks = parentsFirst(
    folders.map(([id, folder]) => ({ key: id, parent: parentOf(folder), name: folder.title })),
  );
  // Where a note is, for the report: its notebooks' names and its title.
  const where = new Map<string | null, string>([[null, '']]);
  for (const { key, parent, name } of notebooks)
    where.set(key, `${where.get(parent) ?? ''}${name}/`);
  const notes: JoplinNote[] = [];
  const encryptedNotes: string[] = [];
  for (const [id, item] of of(TYPE.note)) {
    if (encrypted(item)) {
      encryptedNotes.push(item.path);
      continue;
    }
    const html = item.props.get('markup_language') === '2';
    notes.push({
      key: id,
      parent: parentOf(item),
      title: item.title.trim(),
      path: `${where.get(parentOf(item)) ?? ''}${item.title.trim() || id}`,
      markdown: `${joplinFrontmatter(item, (noteTags.get(id) ?? []).sort())}\n${html ? htmlBlock(item.body) : item.body}`,
      html,
    });
  }
  const noteIds = new Set(notes.map((note) => note.key));
  return {
    format: 'jex',
    notebooks,
    notes,
    resources,
    encrypted: [...items.values()].filter(encrypted).length,
    encryptedNotes,
    target: (_note, url) => {
      const match = /^:\/([0-9a-zA-Z]{32})(?:[#?].*)?$/s.exec(url);
      const id = match?.[1];
      if (!id) return null;
      if (noteIds.has(id)) return { kind: 'note', key: id };
      if (resources.has(id)) return { kind: 'resource', key: id };
      return 'missing';
    },
  };
}

/** `2026-10-24 05:23:19Z`, as Joplin's front matter writes a time, from an ISO time or milliseconds. */
function joplinTime(value: string | undefined): string | null {
  if (!value || value === '0') return null;
  const date = new Date(/^\d+$/.test(value) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/**
 * The front matter Joplin's Markdown + Front Matter export writes for a
 * note (`noteToFrontMatter`): title, dates, source, author, location,
 * to-do state and tags, in its order, each only when set.
 */
function joplinFrontmatter(item: JoplinItem, tags: readonly string[]): string {
  const { props } = item;
  const fields: Record<string, string | string[]> = {};
  const set = (key: string, value: string | null | undefined) => {
    if (value) fields[key] = value;
  };
  set('title', item.title.trim());
  set('updated', joplinTime(props.get('user_updated_time')));
  set('created', joplinTime(props.get('user_created_time')));
  set('source', props.get('source_url'));
  set('author', props.get('author'));
  const place = ['latitude', 'longitude', 'altitude'] as const;
  if (place.some((key) => Number(props.get(key) ?? 0) !== 0)) {
    for (const key of place) set(key, props.get(key));
  }
  if (props.get('is_todo') === '1') {
    fields['completed?'] = (props.get('todo_completed') ?? '0') === '0' ? 'no' : 'yes';
  }
  set('due', joplinTime(props.get('todo_due')));
  if (tags.length > 0) fields['tags'] = [...tags];
  return `---\n${stringify(fields, { lineWidth: 0 })}---\n`;
}

/** Notebooks with each parent before the notebooks in it; one in a loop goes at the top. */
function parentsFirst(notebooks: JoplinNotebook[]): JoplinNotebook[] {
  const byKey = new Map(notebooks.map((notebook) => [notebook.key, notebook]));
  const placed = new Set<string>();
  const ordered: JoplinNotebook[] = [];
  const place = (notebook: JoplinNotebook, seen: Set<string>) => {
    if (placed.has(notebook.key)) return;
    const parent = notebook.parent === null ? undefined : byKey.get(notebook.parent);
    if (parent && seen.has(parent.key)) notebook = { ...notebook, parent: null };
    else if (parent) place(parent, new Set([...seen, notebook.key]));
    placed.add(notebook.key);
    ordered.push(notebook);
  };
  for (const notebook of [...notebooks].sort((a, b) => compare(a.name, b.name))) {
    place(notebook, new Set([notebook.key]));
  }
  return ordered;
}

// By code unit, so the order never depends on a locale.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- Links ----

/** A link in a note that names something in the export, and where it is written. */
export type NoteLink =
  /** A Markdown link to another note: it becomes a wikilink, `text` its text. */
  | { kind: 'note'; key: string; start: number; end: number; text: string; inTable: boolean }
  /** The URL of a link, image or HTML attribute naming a resource: it becomes `attachment:ID`. */
  | { kind: 'resource'; key: string; start: number; end: number }
  /** One that can't be rewritten (a note link in HTML, a missing note or file), as written. */
  | { kind: 'kept'; source: string };

/**
 * The links in `note` that name the export's own notes and resources, as
 * the reader reads the Markdown: in no code, the front matter left alone.
 * In HTML, only `src` and `href` attributes naming resources are rewritten.
 */
export function noteLinks(note: JoplinNote, target: JoplinExport['target']): NoteLink[] {
  const { frontmatter, body } = splitFrontmatter(note.markdown);
  const offset = frontmatter?.length ?? 0;
  const found: NoteLink[] = [];
  if (note.html) {
    found.push(...htmlLinks(body, offset, note, target));
    return found;
  }
  // Each resource's URL, from where its destination is written.
  for (const { url, destination } of linkSpans(note.markdown).urls) {
    if (!destination) continue;
    const named = target(note, url);
    if (named === 'missing') found.push({ kind: 'kept', source: url });
    else if (named?.kind === 'resource')
      found.push({ kind: 'resource', key: named.key, ...destination });
  }
  // Each link to a note, whole, and resources in HTML.
  const walk = (node: Nodes, inTable: boolean) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'html' && start !== undefined && end !== undefined) {
      // As written: in a list or quote, its value has lost their prefixes.
      found.push(...htmlLinks(body.slice(start, end), offset + start, note, target));
      return;
    }
    if (node.type === 'link' && start !== undefined && end !== undefined) {
      const named = target(note, node.url);
      if (named !== null && named !== 'missing' && named.kind === 'note') {
        const plain = node.children.every(
          (child) => child.type !== 'image' && child.type !== 'html',
        );
        found.push(
          plain
            ? {
                kind: 'note',
                key: named.key,
                start: offset + start,
                end: offset + end,
                text: markdownText(node).replace(/\s+/g, ' ').trim(),
                inTable,
              }
            : { kind: 'kept', source: body.slice(start, end) },
        );
      }
    }
    if ('children' in node) {
      for (const child of node.children) walk(child, inTable || node.type === 'tableCell');
    }
  };
  walk(parseMarkdown(body), false);
  return found.sort((a, b) => ('start' in a ? a.start : -1) - ('start' in b ? b.start : -1));
}

/** `src` and `href` attributes in `html` naming resources, at `offset` in the note. */
function htmlLinks(
  html: string,
  offset: number,
  note: JoplinNote,
  target: JoplinExport['target'],
): NoteLink[] {
  const found: NoteLink[] = [];
  for (const match of html.matchAll(/\s(?:src|href)\s*=\s*(["'])(.*?)\1/gis)) {
    const url = match[2] ?? '';
    const named = target(note, url.replaceAll('&amp;', '&'));
    if (named === null) continue;
    if (named === 'missing' || named.kind === 'note') {
      found.push({ kind: 'kept', source: url });
      continue;
    }
    const start = offset + (match.index ?? 0) + match[0].length - url.length - 1;
    found.push({ kind: 'resource', key: named.key, start, end: start + url.length });
  }
  return found;
}

/** What a note's links are rewritten to. */
export type LinkRewrites = {
  /** The wikilink target naming a note's page alone, or undefined when none can. */
  wikilink: (key: string) => { target: string; title: string } | undefined;
  /** A resource's attachment ID on this note's page, or undefined when it wasn't attached. */
  attachment: (key: string) => string | undefined;
};

/**
 * `note`'s Markdown with each of `links` rewritten: a link to a note as a
 * wikilink, keeping its text where it isn't the title (`[[Title|text]]`, a
 * bar written `\|` in a table), and a resource's URL as `attachment:ID`.
 * What can't be rewritten stays as written, and is listed in `unresolved`.
 */
export function rewriteNote(
  note: JoplinNote,
  links: readonly NoteLink[],
  rewrites: LinkRewrites,
): { markdown: string; unresolved: string[] } {
  const unresolved: string[] = [];
  let out = '';
  let at = 0;
  for (const link of links) {
    if (link.kind === 'kept') {
      unresolved.push(link.source);
      continue;
    }
    if (link.start < at) continue;
    const source = note.markdown.slice(link.start, link.end);
    let text: string | undefined;
    if (link.kind === 'resource') {
      const id = rewrites.attachment(link.key);
      text = id === undefined ? undefined : `attachment:${id}`;
    } else {
      text = wikilinkFor(link, rewrites.wikilink(link.key));
    }
    if (text === undefined) {
      unresolved.push(link.kind === 'note' ? link.text || source : source);
      continue;
    }
    out += note.markdown.slice(at, link.start) + text;
    at = link.end;
  }
  return { markdown: out + note.markdown.slice(at), unresolved };
}

/**
 * Which of `links` a saved version of `note` (`markdown`) still holds as
 * written, named as `rewriteNote` names what it couldn't rewrite: so a
 * later run reports what an earlier one left, as it left it.
 */
export function leftAsWritten(
  note: JoplinNote,
  links: readonly NoteLink[],
  markdown: string,
): string[] {
  return links.flatMap((link) => {
    const source = link.kind === 'kept' ? link.source : note.markdown.slice(link.start, link.end);
    if (!markdown.includes(source)) return [];
    return [link.kind === 'note' ? link.text || source : source];
  });
}

// What a wikilink's text after its bar can't hold and still read back as its text.
const UNALIASABLE = /[[\]|\r\n`<\\]/;

function wikilinkFor(
  link: Extract<NoteLink, { kind: 'note' }>,
  named: { target: string; title: string } | undefined,
): string | undefined {
  if (!named) return undefined;
  const { target, title } = named;
  const fold = foldTitle;
  let shown: string | null = link.text === '' ? title : link.text;
  if (fold(shown) === fold(target) || UNALIASABLE.test(shown)) shown = null;
  // Without its own text a link shows its page's title.
  if (shown !== null && target === title && fold(shown) === fold(title)) shown = null;
  return `[[${target}${shown === null ? '' : `${link.inTable ? '\\|' : '|'}${shown}`}]]`;
}

// What a wikilink's target can't hold.
const UNWRITABLE = /[[\]|#^\r\n`<\\]/;

/**
 * The shortest wikilink target naming `page` alone among `pages`, as the
 * reader resolves it: its title, or with as few of the folders above it as
 * it takes (`Home/README`). Undefined when no target can, as for a title a
 * link can't hold or two pages of one title in one folder.
 */
export function wikilinkTarget(
  page: LinkablePage,
  pages: readonly LinkablePage[],
  index: PageIndex,
): string | undefined {
  const { id: pageId, title, folders } = page;
  if (title === null) return undefined;
  for (let k = 0; k <= folders.length; k++) {
    const target = [...folders.slice(folders.length - k), title].join('/');
    if (target !== target.trim() || UNWRITABLE.test(target)) return undefined;
    const [resolved] = resolveWikilinks(
      [{ source: `[[${target}]]`, target, heading: null, shown: null, embed: false }],
      { pages, selfId: '', index },
    );
    if (resolved?.status === 'resolved' && resolved.targets[0] === pageId) return target;
    // A title with a `/` is matched whole first: no folder can be added to it.
    if (title.includes('/')) return undefined;
  }
  return undefined;
}
