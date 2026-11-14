// Import from Joplin and Obsidian (wikistow.md, Import): Joplin's two
// export formats and an Obsidian vault, read into folders, notes and
// files, and each note's links found and rewritten for WikiStow. This part
// is pure; `operations/import.ts` makes the folders and pages.
//
// - Markdown + Front Matter: notebooks as folders, notes as `.md` files
//   (`.html` for HTML notes) with front matter, files in `_resources/`.
//   Links between notes are relative paths, `../Home/README.md`.
// - JEX, a tar of Joplin's raw items, `<id>.md` each: the title, the body,
//   then `key: value` lines, and the files in `resources/`. Links are
//   `:/<id>`. Its notes get the front matter the Markdown export writes.
// - An Obsidian vault: folders, notes as `.md` files titled by their
//   names, and any other files. Links are wikilinks and embeds naming a
//   note or file by name or path, as Obsidian resolves them, or Markdown
//   links to their paths.
import type { Nodes } from 'mdast';
import { parse, stringify } from 'yaml';
import { cleanPath, macOsExtra, type ImportFile } from './import-archive.ts';
import { foldTitle, resolveWikilinks, type LinkablePage, type PageIndex } from './links.ts';
import {
  COLORS,
  linkSpans,
  markdownNodes,
  markdownText,
  parseMarkdown,
  splitFrontmatter,
  type ColorName,
} from './markdown/index.ts';

/** The app notes are imported from. */
export type ImportFrom = 'joplin' | 'obsidian';

/** What was read: one of Joplin's export formats, or an Obsidian vault. */
export type ImportFormat = 'markdown' | 'jex' | 'obsidian';

/** A folder, by its key: its path in a Markdown export or vault, its ID in a JEX. */
export type SourceFolder = { key: string; parent: string | null; name: string };

/**
 * A note: its key, as for a folder, its Markdown with front matter, and
 * where it is in the export: its file in a Markdown export or vault, its
 * notebooks and title in a JEX.
 */
export type SourceNote = {
  key: string;
  parent: string | null;
  title: string;
  path: string;
  markdown: string;
  /** An HTML note, its body raw HTML: no Markdown link in it is read. */
  html: boolean;
};

/** A file notes link to, by its key: its path, or its ID in a JEX. */
export type SourceFile = {
  key: string;
  name: string;
  mediaType: string;
  /** Null when the export has no file for it, or only an encrypted one. */
  file: ImportFile | null;
};

/** What a link in a note names: another note, or a file, by key, and the file's name. */
export type SourceTarget =
  | { kind: 'note'; key: string }
  | { kind: 'resource'; key: string; name: string };

/** A Joplin export or an Obsidian vault, read. */
export type ImportSource = {
  format: ImportFormat;
  /** Parents before the folders in them. */
  folders: SourceFolder[];
  notes: SourceNote[];
  files: ReadonlyMap<string, SourceFile>;
  /** Encrypted items in a JEX, which Joplin must decrypt before exporting. */
  encrypted: number;
  /** Encrypted notes, by where they are in the export. */
  encryptedNotes: string[];
  /** What `url` in `note` names, or null for a link that isn't the export's own. */
  target: (note: SourceNote, url: string) => SourceTarget | 'missing' | null;
  /**
   * What a wikilink's target in `note` names, in a vault, whose wikilinks
   * name its notes and files. A Joplin export's are left as written.
   */
  wikilink?: (note: SourceNote, target: string) => SourceTarget | 'missing';
};

/** The app `format` comes from. */
export const importFrom = (format: ImportFormat): ImportFrom =>
  format === 'obsidian' ? 'obsidian' : 'joplin';

/** The extension namespace naming what an imported folder or page came from. */
export const IMPORT_NAMESPACE = 'wikistow.import';

/** What `wikistow.import` holds: where it came from, and its key there. */
export type ImportMark = { from: ImportFrom; key: string };

/** The extension a folder or page imported from `from` with `key` gets. */
export const importMark = (from: ImportFrom, key: string): Record<string, ImportMark> => ({
  [IMPORT_NAMESPACE]: { from, key },
});

/** The key `extensions` marks an import from `from` with, if it has one. */
export function importKeyOf(
  extensions: Readonly<Record<string, unknown>>,
  from: ImportFrom,
): string | null {
  const mark = extensions[IMPORT_NAMESPACE];
  if (typeof mark !== 'object' || mark === null || !('key' in mark) || !('from' in mark)) {
    return null;
  }
  return mark.from === from && typeof mark.key === 'string' ? mark.key : null;
}

/** A Markdown export's attachment folder; a JEX's. */
const MD_RESOURCES = '_resources';
const JEX_RESOURCES = 'resources';
const JEX_ITEM = /^([0-9a-zA-Z]{32})\.md$/;

/** Media types by extension, for a Markdown export or vault, which doesn't say. */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
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
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'video/webm',
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
export async function readJoplinExport(files: readonly ImportFile[]): Promise<ImportSource> {
  const jex = files.some((file) => JEX_ITEM.test(file.path));
  return jex ? readJex(files) : readMarkdownExport(files);
}

/** `files` read as an export from `from`. */
export const readImport = (files: readonly ImportFile[], from: ImportFrom) =>
  from === 'obsidian' ? readObsidianVault(files) : readJoplinExport(files);

/**
 * Which app `files` came from, by their marks: an Obsidian vault's
 * `.obsidian/` settings folder at the top; a JEX's raw items, or a
 * Markdown export's `_resources/` folder, or every note with a `title` in
 * its front matter, as Joplin writes them. Null when there's no telling,
 * as for a vault zipped without its settings: the person is asked.
 */
export async function importFromOf(files: readonly ImportFile[]): Promise<ImportFrom | null> {
  if (files.some((file) => file.path.startsWith('.obsidian/'))) return 'obsidian';
  if (files.some((file) => JEX_ITEM.test(file.path) || file.path.startsWith(`${MD_RESOURCES}/`))) {
    return 'joplin';
  }
  const notes = files.filter((file) => !hidden(file.path) && /\.md$/i.test(file.path));
  for (const note of notes) {
    if (frontmatterTitle(await textOf(note)) === null) return null;
  }
  return notes.length > 0 ? 'joplin' : null;
}

// ---- Markdown + Front Matter ----

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

async function readMarkdownExport(files: readonly ImportFile[]): Promise<ImportSource> {
  const resources = new Map<string, SourceFile>();
  const notes: SourceNote[] = [];
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
    folders: notebooks,
    notes,
    files: resources,
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
      const resource = resources.get(path);
      if (resource) return { kind: 'resource', key: path, name: resource.name };
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

async function readJex(files: readonly ImportFile[]): Promise<ImportSource> {
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
  const resources = new Map<string, SourceFile>();
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
  const notes: SourceNote[] = [];
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
    folders: notebooks,
    notes,
    files: resources,
    encrypted: [...items.values()].filter(encrypted).length,
    encryptedNotes,
    target: (_note, url) => {
      const match = /^:\/([0-9a-zA-Z]{32})(?:[#?].*)?$/s.exec(url);
      const id = match?.[1];
      if (!id) return null;
      if (noteIds.has(id)) return { kind: 'note', key: id };
      const resource = resources.get(id);
      if (resource) return { kind: 'resource', key: id, name: resource.name };
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
function parentsFirst(notebooks: SourceFolder[]): SourceFolder[] {
  const byKey = new Map(notebooks.map((notebook) => [notebook.key, notebook]));
  const placed = new Set<string>();
  const ordered: SourceFolder[] = [];
  const place = (notebook: SourceFolder, seen: Set<string>) => {
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

// ---- Obsidian vault ----

/** A hidden file or folder, which Obsidian doesn't list: `.obsidian/`, `.trash/`, `.git/`. */
const hidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));

/** `path` percent-decoded, or as it is if it isn't. */
function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * `files` as an Obsidian vault: each `.md` file a note titled by its name,
 * its front matter kept as written, in folders as the vault has them;
 * folders without notes in them are left out. Hidden files and folders are
 * left out too, as Obsidian leaves them out, and so are macOS's extras.
 * Every other file is one a note may link to or embed.
 */
export async function readObsidianVault(files: readonly ImportFile[]): Promise<ImportSource> {
  const notes: SourceNote[] = [];
  const others = new Map<string, SourceFile>();
  const dirs = new Set<string>();
  // Every file's path by its name, lowercased, as Obsidian looks them up.
  const byName = new Map<string, string[]>();
  for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
    if (hidden(file.path) || macOsExtra(file.path)) continue;
    const name = nameOf(file.path);
    const named = byName.get(name.toLowerCase());
    if (named) named.push(file.path);
    else byName.set(name.toLowerCase(), [file.path]);
    if (!name.endsWith('.md')) {
      others.set(file.path, { key: file.path, name, mediaType: mediaTypeOf(name), file });
      continue;
    }
    for (let dir = dirOf(file.path); dir !== ''; dir = dirOf(dir)) dirs.add(dir);
    const parent = dirOf(file.path);
    notes.push({
      key: file.path,
      parent: parent === '' ? null : parent,
      title: name.slice(0, -'.md'.length),
      path: file.path,
      markdown: themeColors(await textOf(file)),
      html: false,
    });
  }
  const folders = [...dirs].sort(compare).map((dir) => {
    const parent = dirOf(dir);
    return { key: dir, parent: parent === '' ? null : parent, name: nameOf(dir) };
  });
  const notePaths = new Set(notes.map((note) => note.key));
  // What a link's path names, by name or path.
  const find = (linkpath: string, from: string): SourceTarget | 'missing' => {
    const path = linkpathDest(byName, linkpath, from);
    if (path === null) return 'missing';
    return notePaths.has(path)
      ? { kind: 'note', key: path }
      : { kind: 'resource', key: path, name: nameOf(path) };
  };
  return {
    format: 'obsidian',
    folders,
    notes,
    files: others,
    encrypted: 0,
    encryptedNotes: [],
    target: (note, url) => {
      if (SCHEME.test(url) || url.startsWith('#')) return null;
      // Obsidian reads a Markdown link's path percent-decoded, and a wikilink's as written.
      const path = decoded(url.replace(/#.*$/s, ''));
      return path === '' ? null : find(path, note.path);
    },
    wikilink: (note, target) => find(target, note.path),
  };
}

// What Obsidian's colour plugins write, plainly one style on a span or a
// mark: Colored Text's `<span style="color: #e03e2d">`, and Highlightr's
// `<mark style="background: #FF5582A6;">`.
const STYLED = /^<(span|mark)\s+style\s*=\s*(["'])\s*([a-z-]+)\s*:\s*([^;"']+?)\s*;?\s*\2\s*>$/i;
const PROPERTY = { span: ['color'], mark: ['background', 'background-color'] } as const;

/** `#rgb`, `#rrggbb`, with or without alpha, or `rgb()` and `rgba()`, as red, green and blue from 0 to 1. */
function rgbOf(value: string): [number, number, number] | null {
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
  if (hex) {
    const long = hex.length <= 4 ? hex.replace(/./g, '$&$&') : hex;
    const [r = 0, g = 0, b = 0] = [0, 2, 4].map((at) => parseInt(long.slice(at, at + 2), 16) / 255);
    return [r, g, b];
  }
  const rgb =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+%?\s*)?\)$/i.exec(value);
  if (!rgb) return null;
  const [r = 0, g = 0, b = 0] = rgb.slice(1, 4).map((part) => Math.min(255, Number(part)) / 255);
  return [r, g, b];
}

/**
 * The theme's colour nearest a CSS colour: one it names, or the one whose
 * hues it falls among. A grey, or one near black or white, has none.
 */
function nearestColor(value: string): ColorName | null {
  const named = value.toLowerCase();
  if ((COLORS as readonly string[]).includes(named)) return named as ColorName;
  const rgb = rgbOf(value);
  if (!rgb) return null;
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.2 || lightness < 0.1 || lightness > 0.97) return null;
  const [r, g, b] = rgb;
  const sector =
    max === r
      ? ((g - b) / chroma + 6) % 6
      : max === g
        ? (b - r) / chroma + 2
        : (r - g) / chroma + 4;
  const hue = sector * 60;
  if (hue < 15 || hue >= 330) return 'red';
  if (hue < 40) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 165) return 'green';
  if (hue < 255) return 'blue';
  return 'purple';
}

/**
 * A vault note's Markdown with what a colour plugin wrote (`STYLED`) naming
 * the theme's nearest colour instead (`nearestColor`): `<span
 * data-color="red">` and `<mark data-color="red">`, which the reader shows
 * in the theme's colours. Any other HTML, a colour with none near it, and
 * what's in code or the front matter stay as written.
 */
export function themeColors(markdown: string): string {
  if (!/<(?:span|mark)\s/i.test(markdown)) return markdown;
  const { frontmatter, body } = splitFrontmatter(markdown);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const node of markdownNodes(parseMarkdown(body))) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type !== 'html' || start === undefined || end === undefined) continue;
    const [, tag = '', , property = '', value = ''] = STYLED.exec(body.slice(start, end)) ?? [];
    const kind = tag.toLowerCase();
    if (kind !== 'span' && kind !== 'mark') continue;
    if (!(PROPERTY[kind] as readonly string[]).includes(property.toLowerCase())) continue;
    const color = nearestColor(value);
    if (color) edits.push({ start, end, text: `<${kind} data-color="${color}">` });
  }
  let out = body;
  for (const { start, end, text } of edits.reverse())
    out = out.slice(0, start) + text + out.slice(end);
  return (frontmatter ?? '') + out;
}

/**
 * The file a link's path (`linkpath`, without its `#heading`) names from
 * the note at `from`, as Obsidian 1.15's `getLinkpathDest` finds it among
 * `byName`, the vault's files by their names, lowercased: by name, with or
 * without `.md`, and case aside. Of several of that name, the one at a
 * relative path (`./`, `../`) or the path from the vault's top, else those
 * whose path ends with it, the ones under the note's folder first, then
 * the shortest path.
 */
function linkpathDest(
  byName: ReadonlyMap<string, readonly string[]>,
  linkpath: string,
  from: string,
): string | null {
  let wanted = linkpath.toLowerCase();
  let name = nameOf(wanted);
  let found = name.includes('.') ? byName.get(name) : undefined;
  if (!found) {
    wanted = `${linkpath}.md`.toLowerCase();
    name = nameOf(wanted);
    found = byName.get(name);
  }
  if (!found) return null;
  const candidates = found;
  if (name === wanted && candidates.length === 1) return candidates[0] ?? null;
  const at = (path: string) =>
    candidates.find((candidate) => candidate.toLowerCase() === path) ?? null;
  let dir = dirOf(from).toLowerCase();
  if (wanted.startsWith('./') || wanted.startsWith('../')) {
    if (wanted.startsWith('./../')) wanted = wanted.slice(2);
    if (wanted.startsWith('./')) {
      wanted = `${dir === '' ? '' : `${dir}/`}${wanted.slice(2)}`;
    } else {
      while (wanted.startsWith('../')) {
        wanted = wanted.slice(3);
        dir = dirOf(dir);
      }
      wanted = `${dir === '' ? '' : `${dir}/`}${wanted}`;
    }
    const relative = at(wanted);
    if (relative) return relative;
  }
  if (wanted.startsWith('/')) wanted = wanted.slice(1);
  const exact = at(wanted);
  if (exact) return exact;
  if (linkpath.startsWith('/')) return null;
  const near: string[] = [];
  const far: string[] = [];
  for (const path of candidates) {
    const lower = path.toLowerCase();
    if (lower.endsWith(wanted)) (lower.startsWith(dir) ? near : far).push(path);
  }
  const shortest = (a: string, b: string) => a.length - b.length;
  return near.sort(shortest)[0] ?? far.sort(shortest)[0] ?? null;
}

// ---- Links ----

/** A link in a note that names something in the export, and where it is written. */
export type NoteLink =
  /** A Markdown link to another note: it becomes a wikilink, `text` its text. */
  | { kind: 'note'; key: string; start: number; end: number; text: string; inTable: boolean }
  /** The URL of a link, image or HTML attribute naming a file: it becomes `attachment:ID`. */
  | { kind: 'resource'; key: string; name: string; start: number; end: number }
  /**
   * A vault's wikilink to a note, null when the vault has none of that
   * name: rewritten only when it doesn't name that page as written.
   */
  | {
      kind: 'wikilink';
      key: string | null;
      start: number;
      end: number;
      source: string;
      target: string;
      heading: string | null;
      shown: string | null;
      inTable: boolean;
    }
  /**
   * A vault's embed or wikilink naming a file (`![[photo.png|300]]`,
   * `[[doc.pdf]]`): an embed names its page's attachment by name, a link
   * becomes a Markdown one to `attachment:ID`.
   */
  | {
      kind: 'file';
      key: string;
      name: string;
      start: number;
      end: number;
      embed: boolean;
      /** An image's: a Markdown image, if it can't stay an embed. */
      image: boolean;
      target: string;
      heading: string | null;
      shown: string | null;
      inTable: boolean;
    }
  /** One that can't be rewritten (a note link in HTML, a missing note or file), as written. */
  | { kind: 'kept'; source: string };

/**
 * The links in `note` that name the export's own notes and files, as the
 * reader reads the Markdown: in no code, the front matter left alone. In
 * HTML, only `src` and `href` attributes naming files are rewritten. In a
 * vault, wikilinks and embeds too, but not page embeds (`![[Note]]`),
 * block references (`[[Note#^id]]`) or links to this note's headings,
 * which stay as written.
 */
export function noteLinks(
  note: SourceNote,
  { target, wikilink, files }: Pick<ImportSource, 'target' | 'wikilink' | 'files'>,
): NoteLink[] {
  const { frontmatter, body } = splitFrontmatter(note.markdown);
  const offset = frontmatter?.length ?? 0;
  const found: NoteLink[] = [];
  if (note.html) {
    found.push(...htmlLinks(body, offset, note, target));
    return found;
  }
  // Each file's URL, from where its destination is written.
  for (const { url, destination } of linkSpans(note.markdown).urls) {
    if (!destination) continue;
    const named = target(note, url);
    if (named === 'missing') found.push({ kind: 'kept', source: url });
    else if (named?.kind === 'resource')
      found.push({ kind: 'resource', key: named.key, name: named.name, ...destination });
  }
  // Each link to a note, whole, and files in HTML.
  const walk = (node: Nodes, inTable: boolean) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'html' && start !== undefined && end !== undefined) {
      // As written: in a list or quote, its value has lost their prefixes.
      found.push(...htmlLinks(body.slice(start, end), offset + start, note, target));
      return;
    }
    if (
      node.type === 'wikilink' &&
      wikilink &&
      !node.unsupported &&
      node.target !== '' &&
      start !== undefined &&
      end !== undefined
    ) {
      const named = wikilink(note, node.target);
      const at = { start: offset + start, end: offset + end };
      const { source, target, heading, shown, embed } = node;
      if (named === 'missing') {
        found.push(
          embed
            ? { kind: 'kept', source }
            : { kind: 'wikilink', key: null, ...at, source, target, heading, shown, inTable },
        );
      } else if (named.kind === 'resource') {
        const image = files.get(named.key)?.mediaType.startsWith('image/') ?? false;
        const { key, name } = named;
        found.push({
          kind: 'file',
          key,
          name,
          ...at,
          embed,
          image,
          target,
          heading,
          shown,
          inTable,
        });
      } else if (!embed) {
        found.push({
          kind: 'wikilink',
          key: named.key,
          ...at,
          source,
          target,
          heading,
          shown,
          inTable,
        });
      }
    }
    // A reference's definition naming a note: Joplin never writes one; reported, not rewritten.
    if (node.type === 'definition') {
      const named = target(note, node.url);
      if (named !== null && named !== 'missing' && named.kind === 'note') {
        found.push({ kind: 'kept', source: node.url });
      }
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

/** `src` and `href` attributes in `html` naming files, at `offset` in the note. */
function htmlLinks(
  html: string,
  offset: number,
  note: SourceNote,
  target: ImportSource['target'],
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
    found.push({ ...named, start, end: start + url.length });
  }
  return found;
}

/** What a note's links are rewritten to. */
export type LinkRewrites = {
  /** The wikilink target naming a note's page alone, or undefined when none can. */
  wikilink: (key: string) => { target: string; title: string } | undefined;
  /**
   * A file's attachment on this note's page: its ID, and whether it is the
   * page's only attachment of its name, as an embed names it. Undefined
   * when it wasn't attached.
   */
  attachment: (key: string) => { id: string; alone: boolean } | undefined;
  /**
   * Whether a wikilink's target, as written, names the page made for the
   * note of `key` alone; with `key` null, whether it names any one page.
   */
  resolves: (target: string, key: string | null) => boolean;
};

/**
 * `note`'s Markdown with each of `links` rewritten: a link to a note as a
 * wikilink, keeping its text where it isn't the title (`[[Title|text]]`, a
 * bar written `\|` in a table), and a file's URL as `attachment:ID`. A
 * vault's wikilink to a note changes only when it wouldn't name that page
 * as written, keeping its heading and text; one naming a file becomes a
 * Markdown image or link to the attachment. What can't be rewritten stays
 * as written, and is listed in `unresolved`.
 */
export function rewriteNote(
  note: SourceNote,
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
      const attached = rewrites.attachment(link.key);
      text = attached && `attachment:${attached.id}`;
    } else if (link.kind === 'file') {
      const attached = rewrites.attachment(link.key);
      const rewritten = attached && fileLink(link, attached);
      // An embed that names its attachment as written.
      if (rewritten === null) continue;
      text = rewritten;
    } else if (link.kind === 'wikilink') {
      // It works as written.
      if (rewrites.resolves(link.target, link.key)) continue;
      text = link.key === null ? undefined : vaultWikilink(link, rewrites.wikilink(link.key));
    } else {
      text = wikilinkFor(link, rewrites.wikilink(link.key));
    }
    if (text === undefined) {
      unresolved.push(labelOf(link, source));
      continue;
    }
    out += note.markdown.slice(at, link.start) + text;
    at = link.end;
  }
  return { markdown: out + note.markdown.slice(at), unresolved };
}

/**
 * How the report names a link left as written: a Markdown link to a note
 * by its text, a file by its name, a wikilink as written.
 */
const labelOf = (link: Exclude<NoteLink, { kind: 'kept' }>, source: string) =>
  link.kind === 'note' ? link.text || source : link.kind === 'wikilink' ? source : link.name;

/**
 * Which of `links` a saved version of `note` still holds as written, named
 * as `rewriteNote` names what it couldn't rewrite: so a later run reports
 * what an earlier one left, as it left it. A vault's wikilink that names
 * its page as written, and an embed naming one of the version's
 * attachments, were left so on purpose.
 */
export function leftAsWritten(
  note: SourceNote,
  links: readonly NoteLink[],
  saved: { markdown: string; attachments: readonly { name: string }[] },
  { resolves }: Pick<LinkRewrites, 'resolves'>,
): string[] {
  const named = (target: string) =>
    saved.attachments.filter((a) => foldTitle(a.name) === foldTitle(target)).length === 1;
  return links.flatMap((link) => {
    if (link.kind === 'wikilink' && resolves(link.target, link.key)) return [];
    if (link.kind === 'file' && link.embed && named(link.target)) return [];
    if (link.kind === 'kept') return saved.markdown.includes(link.source) ? [link.source] : [];
    // With a character either side, so a link isn't found inside another
    // (`[[doc.pdf]]` in `![[doc.pdf]]`), or a path in a rewritten link's text.
    const around = note.markdown.slice(Math.max(0, link.start - 1), link.end + 1);
    if (!saved.markdown.includes(around)) return [];
    return [labelOf(link, note.markdown.slice(link.start, link.end))];
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
  let shown: string | null = link.text === '' ? title : link.text;
  // Without its own text a link shows its page's title, so text that is
  // the title, case and all, needs no bar.
  if (UNALIASABLE.test(shown) || (shown === title && target === title)) shown = null;
  return `[[${target}${shown === null ? '' : `${link.inTable ? '\\|' : '|'}${shown}`}]]`;
}

/**
 * A vault's wikilink to `named`, its heading and text kept. Without text of
 * its own it shows its target as written, without `.md`, as Obsidian does.
 */
function vaultWikilink(
  link: Extract<NoteLink, { kind: 'wikilink' }>,
  named: { target: string; title: string } | undefined,
): string | undefined {
  if (!named) return undefined;
  const written = link.target.replace(/\.md$/i, '');
  const shown =
    link.shown ?? (written === named.target || UNALIASABLE.test(written) ? null : written);
  const heading = link.heading === null ? '' : `#${link.heading}`;
  return `[[${named.target}${heading}${shown === null ? '' : `${link.inTable ? '\\|' : '|'}${shown}`}]]`;
}

/**
 * A vault's embed or link naming a file, for its page. An embed stays one,
 * its size or text as written (`![[photo.png|300]]`), naming the page's
 * attachment by its name: unchanged where it already does, case aside.
 * The reader shows the image at its own size, the size kept for going
 * back to Obsidian. A link, or an
 * embed whose name the page's attachments share or a wikilink can't hold,
 * becomes what uploading it writes: `![name](attachment:ID)` for an image's
 * embed, `[name](attachment:ID)` otherwise, with the link's own text.
 * Null when it stays as written.
 */
function fileLink(
  link: Extract<NoteLink, { kind: 'file' }>,
  { id, alone }: { id: string; alone: boolean },
): string | null {
  if (link.embed && alone && !UNWRITABLE.test(link.name)) {
    if (foldTitle(link.target) === foldTitle(link.name)) return null;
    const heading = link.heading === null ? '' : `#${link.heading}`;
    const shown = link.shown === null ? '' : `${link.inTable ? '\\|' : '|'}${link.shown}`;
    return `![[${link.name}${heading}${shown}]]`;
  }
  const size = link.shown !== null && /^\d+(?:x\d+)?$/.test(link.shown);
  const text = (link.shown === null || (link.embed && size) ? link.name : link.shown).replace(
    /[\\[\]*_`<>|]/g,
    '\\$&',
  );
  return `${link.embed && link.image ? '!' : ''}[${text}](attachment:${id})`;
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
