// Markdown export (wikistow.md, Editor and file portability): the files a
// space, or a folder of it, becomes. Each page is one `.md` file in folders
// that mirror the tree, its frontmatter and line endings as written, and
// each attachment is a file in the space's `attachments/` folder. Wikilinks
// name the files written, so the export opens as an Obsidian vault. This
// part is pure; `operations/export.ts` opens the pages and attachments.

import { linkTableOf, resolveLinked } from './link-table.ts';
import { pageIndex, type LinkablePage, type PageIndex } from './links.ts';
import { linkSpans, withHeading, type LinkSpans, type Wikilink } from './markdown/index.ts';
import type { AttachmentRef, PagePayload } from './payload.ts';

// ---- File names ----

/** UTF-8 bytes a name keeps before its suffix and extension. */
const NAME_BYTES = 200;
/** Characters an attachment's extension may have; a longer one is part of its name. */
const EXTENSION_LENGTH = 16;
/** UTF-8 bytes an extension keeps, its dot included. */
const EXTENSION_BYTES = 32;
/** UTF-8 bytes of a whole file or folder name, suffix and extension included: under the 255 file systems allow. */
export const EXPORT_NAME_BYTES = 240;
/** UTF-8 bytes of the stem an extension never takes. */
const MIN_STEM_BYTES = 64;

// What no file name holds on Windows, macOS or Linux (`/\<>:"|?*`), what a
// wikilink can't (`#^[]|`, and a backtick, which could open a code span),
// and control, line separator and bidi characters.
const UNSAFE =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  /[/\\<>:"|?*#^[\]`\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
// Windows refuses these as a name's part before its first dot, in any case.
const RESERVED =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
// Windows drops trailing dots and spaces, and a leading dot hides a file.
const ENDS = /^[\s.]+|[\s.]+$/gu;
const TRAILING = /[\s.]+$/u;

/** The attachments folder at the top of each space's export. */
export const ATTACHMENTS_DIR = 'attachments';

/** A name as file names compare on case-insensitive systems, and a little more. */
export const foldName = (name: string) =>
  name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

const utf8Length = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};

const byteLength = (text: string) => {
  let bytes = 0;
  for (const char of text) bytes += utf8Length(char);
  return bytes;
};

/** NFC `text` cut to at most `bytes` of UTF-8, at a code point, so never inside a surrogate pair. */
function capBytes(text: string, bytes: number): string {
  const chars = Array.from(text);
  let kept = 0;
  for (let used = 0; kept < chars.length; kept++) {
    used += utf8Length(chars[kept] ?? '');
    if (used > bytes) break;
  }
  // Composing what is left may change its length; cut until it fits.
  for (; kept > 0; kept--) {
    const cut = chars.slice(0, kept).join('').normalize('NFC');
    if (byteLength(cut) <= bytes) return cut;
  }
  return '';
}

/** A name split where a suffix goes: `stem (2)ext`. */
export type SafeName = { stem: string; ext: string };

/**
 * `name` as a file name every system takes: NFC, unsafe characters as `_`,
 * no leading or trailing dots or spaces, at most `NAME_BYTES` before the
 * extension, `fallback` when nothing is left, and `_` before a name Windows
 * reserves. With `extension`, a short final `.ext` is kept apart, at most
 * `EXTENSION_BYTES`, so a suffix goes before it. `exportFileName` puts it together.
 */
export function safeName(
  name: string,
  { fallback, extension = false }: { fallback: string; extension?: boolean },
): SafeName {
  const clean = name.toWellFormed().normalize('NFC').replace(UNSAFE, '_').replace(TRAILING, '');
  const dot = extension ? clean.lastIndexOf('.') : -1;
  // `.png` alone is an extension too, and gets the fallback for a name.
  const split = dot >= 0 && Array.from(clean.slice(dot + 1)).length <= EXTENSION_LENGTH;
  // Cut at a character, and its end cleaned again: `.a b` may end at the space.
  const ext = split ? capBytes(clean.slice(dot), EXTENSION_BYTES).replace(TRAILING, '') : '';
  let stem = capBytes(split ? clean.slice(0, dot) : clean, NAME_BYTES).replace(ENDS, '');
  if (stem === '') stem = fallback;
  const base = stem.split('.')[0]?.replace(/ +$/, '') ?? '';
  return { stem: RESERVED.test(base) ? `_${stem}` : stem, ext };
}

/**
 * `name` as written, with ` (n)` before its extension for the nth of a
 * name, at most `EXPORT_NAME_BYTES` in all. The stem is cut to fit, keeping its
 * start (and any `_` before a reserved name), and the extension too if it
 * leaves the stem less than `MIN_STEM_BYTES`.
 */
export function exportFileName({ stem, ext }: SafeName, n = 1): string {
  const suffix = n > 1 ? ` (${n})` : '';
  const room = EXPORT_NAME_BYTES - byteLength(suffix);
  const extension = capBytes(ext, room - MIN_STEM_BYTES).replace(TRAILING, '');
  const name = `${capBytes(stem, room - byteLength(extension))}${suffix}${extension}`;
  return name.replace(TRAILING, '');
}

type Claim = { id: string; name: SafeName; place: (name: string) => void };

/**
 * Give each claim a name in one folder, unique case-insensitively among
 * them and `reserved`. They are taken in order of name, then ID, so the
 * same tree gets the same names on every run: the first of a name keeps
 * it, and the rest get ` (2)`, ` (3)`… before the extension, skipping any
 * name already taken.
 */
function allocate(claims: readonly Claim[], reserved: readonly string[]): void {
  const taken = new Set(reserved.map(foldName));
  const sorted = claims
    .map((claim) => ({ claim, key: foldName(exportFileName(claim.name)) }))
    .sort((a, b) => compare(a.key, b.key) || compare(a.claim.id, b.claim.id));
  const rest: Claim[] = [];
  for (const { claim, key } of sorted) {
    if (taken.has(key)) {
      rest.push(claim);
      continue;
    }
    taken.add(key);
    claim.place(exportFileName(claim.name));
  }
  for (const claim of rest) {
    for (let n = 2; ; n++) {
      const name = exportFileName(claim.name, n);
      if (taken.has(foldName(name))) continue;
      taken.add(foldName(name));
      claim.place(name);
      break;
    }
  }
}

// By code unit, so the order never depends on a locale.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- Planning ----

export type ExportFolder = { id: string; parentId: string | null; name: string | null };
export type ExportPage = { id: string; parentId: string | null; payload: PagePayload };

/** One space's part of an export. A folder or page whose parent isn't listed is at its top. */
export type ExportSpace = {
  /** The folder the space's files go in, by name, or null for the top of the export. */
  dir: string | null;
  folders: readonly ExportFolder[];
  pages: readonly ExportPage[];
  /** Every page the viewer sees in the space, as links resolve (`linkablePages`). */
  linkable: readonly LinkablePage[];
};

/**
 * A file to write, at a `/`-separated path relative to the export's top. A
 * page whose links couldn't be read (`unread`) is written as it was.
 */
export type ExportFile =
  | {
      kind: 'page';
      path: string;
      space: number;
      pageId: string;
      markdown: string;
      unread?: true;
    }
  | { kind: 'attachment'; path: string; space: number; pageId: string; ref: AttachmentRef };

/** Every folder to make, parents first, and every file. */
export type ExportPlan = { dirs: string[]; files: ExportFile[] };

/** The name a folder or space without a readable name gets. */
const UNREADABLE_FOLDER = 'Unreadable folder';

/**
 * Where each page, folder and attachment of `spaces` goes, and each page's
 * Markdown with its links rewritten (`exportedMarkdown`).
 */
export const planExport = (listed: readonly ExportSpace[]): ExportPlan =>
  finish(planningExport(listed));

/** How many pages' Markdown a plan has written, of how many. */
export type PlanProgress = { done: number; total: number };

/**
 * What a plan in steps asks of whoever runs it: to hear how far it has got,
 * after each page's Markdown, or to read a page's links (`linkSpans`) and
 * hand them back with `next`, or throw what stopped the read with `throw`,
 * when the page is exported as written.
 */
export type PlanStep = { progress: PlanProgress } | { read: string };

/** A plan in steps (`PlanStep`), returning `T`. */
export type Planning<T> = Generator<PlanStep, T, LinkSpans | undefined>;

/**
 * `planExport` in steps, most of its work, so a caller can report how far
 * it has got, stop, let others run, and read links somewhere else, such as
 * a worker it can end.
 */
export function* planningExport(listed: readonly ExportSpace[]): Planning<ExportPlan> {
  // A lying tree may list a page or attachment twice; the first counts.
  const spaces = listed.map((space) => ({
    ...space,
    pages: firstOfEach(space.pages).map((page) => ({
      ...page,
      payload: { ...page.payload, attachments: firstOfEach(page.payload.attachments) },
    })),
  }));
  const dirs: string[] = [];
  const pagePaths = new Map<string, string>();
  const attachmentPaths = new Map<string, string>();
  const join = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`);
  const spaceRoots: string[] = spaces.map(() => '');
  const top: Claim[] = [];
  spaces.forEach((space, i) => {
    if (space.dir === null) return;
    top.push({
      id: String(i).padStart(8, '0'),
      name: safeName(space.dir, { fallback: UNREADABLE_FOLDER }),
      place: (name) => {
        spaceRoots[i] = name;
        dirs.push(name);
      },
    });
  });
  // A space at the top has its attachments folder there.
  const atTop = spaces.flatMap((space, i) => (space.dir === null ? [i] : []));
  allocate(top, atTop.length > 0 ? [ATTACHMENTS_DIR] : []);

  spaces.forEach((space, i) => {
    const root = spaceRoots[i] ?? '';
    const key = (id: string) => `${i}\0${id}`;
    const folderIds = new Set(space.folders.map((folder) => folder.id));
    const parentOf = (parentId: string | null) =>
      parentId !== null && folderIds.has(parentId) ? parentId : null;
    const foldersIn = groupBy(space.folders, (folder) => parentOf(folder.parentId));
    const pagesIn = groupBy(space.pages, (page) => parentOf(page.parentId));
    const visited = new Set<string>();
    const place = (dir: string, parentId: string | null, reserved: readonly string[]) => {
      const claims: Claim[] = [];
      const children: { id: string; path: () => string }[] = [];
      for (const folder of foldersIn.get(parentId) ?? []) {
        if (folder.id === parentId || visited.has(folder.id)) continue;
        visited.add(folder.id);
        let path = '';
        claims.push({
          id: folder.id,
          name: safeName(folder.name ?? '', { fallback: UNREADABLE_FOLDER }),
          place: (name) => {
            path = join(dir, name);
          },
        });
        children.push({ id: folder.id, path: () => path });
      }
      for (const page of pagesIn.get(parentId) ?? []) {
        const { stem } = safeName(page.payload.title, { fallback: 'Untitled' });
        claims.push({
          id: page.id,
          name: { stem, ext: '.md' },
          place: (name) => pagePaths.set(key(page.id), join(dir, name)),
        });
      }
      allocate(claims, reserved);
      children.sort((a, b) => compare(foldName(a.path()), foldName(b.path())));
      for (const child of children) {
        dirs.push(child.path());
        place(child.path(), child.id, []);
      }
    };
    place(root, null, [ATTACHMENTS_DIR]);

    const attachmentsDir = join(root, ATTACHMENTS_DIR);
    const claims: Claim[] = [];
    for (const page of space.pages) {
      if (!pagePaths.has(key(page.id))) continue;
      for (const ref of page.payload.attachments) {
        claims.push({
          id: `${page.id}\0${ref.id}`,
          name: safeName(ref.name, { fallback: 'attachment', extension: true }),
          place: (name) =>
            attachmentPaths.set(`${key(page.id)}\0${ref.id}`, join(attachmentsDir, name)),
        });
      }
    }
    if (claims.length > 0) dirs.push(attachmentsDir);
    allocate(claims, []);
  });

  const targets = linkTargets([...pagePaths.values()], [...attachmentPaths.values()]);
  const files: ExportFile[] = [];
  const progress = { done: 0, total: pagePaths.size };
  // Before the first page is read, which may take a while.
  yield { progress: { ...progress } };
  for (const [i, space] of spaces.entries()) {
    const key = (id: string) => `${i}\0${id}`;
    const index = pageIndex(space.linkable);
    for (const page of space.pages) {
      const path = pagePaths.get(key(page.id));
      if (path === undefined) continue;
      const writing = exportingMarkdown(page.payload, {
        selfId: page.id,
        linkable: space.linkable,
        index,
        dir: dirOf(path),
        pageTarget: (pageId) => {
          const at = pagePaths.get(key(pageId));
          return at === undefined ? undefined : targets.get(at);
        },
        attachmentPath: (attachmentId) => attachmentPaths.get(`${key(page.id)}\0${attachmentId}`),
      });
      const { markdown, unread } = yield* writing;
      files.push({
        kind: 'page',
        path,
        space: i,
        pageId: page.id,
        markdown,
        ...(unread && { unread }),
      });
      for (const ref of page.payload.attachments) {
        const at = attachmentPaths.get(`${key(page.id)}\0${ref.id}`);
        if (at !== undefined)
          files.push({ kind: 'attachment', path: at, space: i, pageId: page.id, ref });
      }
      progress.done++;
      yield { progress: { ...progress } };
    }
  }
  return { dirs, files };
}

/** What `steps` returns, run to the end, its links read here. */
function finish<T>(steps: Planning<T>): T {
  let step = steps.next();
  while (!step.done) {
    if ('progress' in step.value) {
      step = steps.next();
      continue;
    }
    let read: LinkSpans;
    try {
      read = linkSpans(step.value.read);
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(read);
  }
  return step.value;
}

/** Ask whoever runs the plan for `markdown`'s links (`PlanStep`). */
function* read(markdown: string): Planning<LinkSpans> {
  const links = yield { read: markdown };
  if (!links) throw new Error('unreachable: a read is answered with links');
  return links;
}

/** `items` by `keyOf`, each group in their order. */
function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

const firstOfEach = <T extends { id: string }>(items: readonly T[]): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)));
};

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * The text a wikilink names each page file by, as Obsidian's "shortest
 * path when possible" writes it: the file's name, `.md` left off, when no
 * other file written has that name, case-insensitively; else its path from
 * the export's top, which Obsidian matches before any name.
 */
function linkTargets(
  pages: readonly string[],
  attachments: readonly string[],
): Map<string, string> {
  const keyOf = (path: string) => (path.endsWith('.md') ? path.slice(0, -3) : path);
  const nameOf = (path: string) => keyOf(path).slice(path.lastIndexOf('/') + 1);
  const counts = new Map<string, number>();
  for (const path of [...pages, ...attachments]) {
    const name = foldName(nameOf(path));
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(
    pages.map((path) => [
      path,
      counts.get(foldName(nameOf(path))) === 1 ? nameOf(path) : keyOf(path),
    ]),
  );
}

/** `path` relative to the folder `from`, both `/`-separated from the export's top. */
export function relativePath(from: string, path: string): string {
  const a = from === '' ? [] : from.split('/');
  const b = path.split('/');
  let same = 0;
  while (same < a.length && same < b.length - 1 && a[same] === b[same]) same++;
  return [...a.slice(same).map(() => '..'), ...b.slice(same)].join('/');
}

// ---- Rewriting a page ----

/** What a page's links are rewritten against. */
export type ExportLinks = {
  selfId: string;
  /** Every page the viewer sees in the space, for resolving its links. */
  linkable: readonly LinkablePage[];
  /** `pageIndex(linkable)`. */
  index: PageIndex;
  /** The page's folder in the export. */
  dir: string;
  /** The wikilink text naming a page's file, or none when it isn't exported. */
  pageTarget: (pageId: string) => string | undefined;
  /** Where one of the page's attachments is written, from the export's top. */
  attachmentPath: (attachmentId: string) => string | undefined;
};

/** One replacement, and what the link it changes reads back as: a wikilink's target, or a URL. */
type Edit = {
  start: number;
  end: number;
  text: string;
  reads: { wikilink: string } | { url: string; node: number };
};

/**
 * `payload`'s Markdown as exported. A page wikilink resolves as the reader
 * resolves it (`resolveLinked`): through the version's link table where it
 * names a page the viewer sees, else by title. One naming an exported page
 * names its file instead, keeping its `#heading` and `|text`; one without
 * its own text that names the file otherwise than by the title gets the
 * title as its text. An embed of one of the page's attachments, and a Markdown
 * link or image to `attachment:ID`, get the file's relative path; an
 * autolink `<attachment:ID>` becomes a link to it, named after it. Every
 * other link (missing, ambiguous, or to a page not exported) stays as
 * written, and so do frontmatter and line endings. If the result wouldn't
 * read back as the same links rewritten, only its wikilinks are, or only
 * its URLs, or nothing.
 */
export const exportedMarkdown = (payload: PagePayload, links: ExportLinks): string =>
  finish(exportingMarkdown(payload, links)).markdown;

/**
 * `exportedMarkdown` in steps, asking for each read (`PlanStep`), and
 * whether it is as written because a read failed (`unread`).
 */
function* exportingMarkdown(
  payload: PagePayload,
  links: ExportLinks,
): Planning<{ markdown: string; unread?: true }> {
  const { markdown } = payload;
  if (!REWRITABLE.test(markdown)) return { markdown };
  let before: LinkSpans;
  let edits: Edit[];
  try {
    before = yield* read(markdown);
    edits = [
      ...wikilinkEdits(markdown, before, payload, links),
      ...attachmentUrlEdits(before, links),
    ];
  } catch {
    // Too much for the parser, or too slow: no link can be found, so none is rewritten.
    return { markdown, unread: true };
  }
  const wikilinksOnly = edits.filter((edit) => 'wikilink' in edit.reads);
  const urlsOnly = edits.filter((edit) => 'url' in edit.reads);
  for (const tried of [edits, wikilinksOnly, urlsOnly]) {
    if (tried.length === 0) continue;
    const next = applyEdits(markdown, tried);
    const reads = yield* readsBack(next, before, tried);
    if (reads === true) return { markdown: next };
    // A rewrite that can't be checked: the smaller ones likely can't either.
    if (reads === null) return { markdown, unread: true };
  }
  return { markdown };
}

// What every link rewritten is written with: a wikilink's `[[`, the `](`
// of a link or image, the `]:` of a definition, before its destination, or
// an attachment's autolink.
const REWRITABLE = /\[\[|\]\(|\]:|<attachment:/;

const ATTACHMENT_SCHEME = 'attachment:';

/** A path as a Markdown link's URL: each part percent-encoded, which Obsidian reads back. */
export const pathUrl = (path: string) =>
  path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');

function wikilinkEdits(
  markdown: string,
  { wikilinks, tables }: LinkSpans,
  payload: PagePayload,
  links: ExportLinks,
): Edit[] {
  const resolved = resolveLinked(wikilinks, {
    pages: links.linkable,
    index: links.index,
    selfId: links.selfId,
    table: linkTableOf(payload),
    attachments: payload.attachments,
  });
  const edits: Edit[] = [];
  // Links and tables are in order, and tables don't overlap: the first not
  // ended before a link is the only one it can be in.
  let table = 0;
  wikilinks.forEach((link, i) => {
    while ((tables[table]?.end ?? Infinity) < link.end) table++;
    const found = resolved[i];
    if (found?.status !== 'resolved' || link.target === '') return;
    if (markdown.slice(link.start, link.end) !== link.source) return;
    const inTable = (tables[table]?.start ?? Infinity) <= link.start;
    const [id = ''] = found.targets;
    const edit = (target: string, shown: string | null) =>
      edits.push({
        start: link.start,
        end: link.end,
        text: retarget(link, target, shown, inTable),
        reads: { wikilink: target },
      });
    if (link.embed) {
      const path = links.attachmentPath(id);
      if (path !== undefined) edit(relativePath(links.dir, path), null);
      return;
    }
    const target = links.pageTarget(id);
    if (target === undefined) return;
    const title = links.index.titles.get(id) ?? null;
    const shown =
      link.shown === null && title !== null && target !== title && aliasable(title)
        ? withHeading(title, link.heading)
        : null;
    if (target !== link.target || shown !== null) edit(target, shown);
  });
  return edits;
}

// Text that can stand after a wikilink's bar and still read back as its text.
const aliasable = (text: string) => !/[[\]|\r\n`<\\]/.test(text) && text.trim() === text;

/** `link`'s source with `target` in place of its target; its heading and text stay, or `shown` is added. */
function retarget(link: Wikilink, target: string, shown: string | null, inTable: boolean): string {
  const { source } = link;
  const embed = source.startsWith('!');
  const inner = source.slice(embed ? 3 : 2, -2);
  const bar = inner.indexOf('|');
  let ref = bar < 0 ? inner : inner.slice(0, bar);
  let rest = bar < 0 ? '' : inner.slice(bar);
  // In a table the bar is written `\|`, its backslash just before it.
  if (bar >= 0 && ref.endsWith('\\')) {
    ref = ref.slice(0, -1);
    rest = `\\${rest}`;
  }
  const hash = ref.indexOf('#');
  const heading = hash < 0 ? '' : ref.slice(hash);
  if (shown !== null && rest === '') rest = `${inTable ? '\\|' : '|'}${shown}`;
  return `${embed ? '!' : ''}[[${target}${heading}${rest}]]`;
}

/**
 * Each `attachment:ID` destination of a Markdown link, image or definition
 * naming one of the page's exported attachments, as the file's relative path.
 * A relative path can't be an autolink, so `<attachment:ID>` becomes
 * `[name](path)`, its text the file's name, and a `!` or `[` just before it
 * is escaped.
 */
function attachmentUrlEdits({ urls }: LinkSpans, links: ExportLinks): Edit[] {
  const edits: Edit[] = [];
  urls.forEach(({ url, destination, autolink }, node) => {
    const at = destination ?? autolink;
    if (!at || !url.startsWith(ATTACHMENT_SCHEME)) return;
    const path = links.attachmentPath(url.slice(ATTACHMENT_SCHEME.length));
    if (path === undefined) return;
    const target = pathUrl(relativePath(links.dir, path));
    const name = escapeText(path.slice(path.lastIndexOf('/') + 1));
    const escaped = autolink?.before ? `\\${autolink.before}` : '';
    const text = destination ? target : `${escaped}[${name}](${target})`;
    edits.push({ ...at, text, reads: { url: target, node } });
  });
  return edits;
}

// What could make a file name read as more than text in a link's text, and
// `|`, which ends a table's cell. File names have no line breaks.
const escapeText = (text: string) => text.replace(/[\\`*_~&<>[\]|!]/g, '\\$&');

function applyEdits(markdown: string, edits: readonly Edit[]): string {
  let out = '';
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < at) continue;
    out += markdown.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + markdown.slice(at);
}

/** Whether `next` reads as the links `before` with exactly `edits` made, or null if it couldn't be read. */
function* readsBack(
  next: string,
  before: LinkSpans,
  edits: readonly Edit[],
): Planning<boolean | null> {
  let after: LinkSpans;
  try {
    after = yield* read(next);
  } catch {
    return null;
  }
  const targets = new Map<number, string>();
  const urlsAt = new Map<number, string>();
  for (const { start, reads } of edits.toReversed()) {
    if ('wikilink' in reads) targets.set(start, reads.wikilink);
    else urlsAt.set(reads.node, reads.url);
  }
  const wikilinks = before.wikilinks.map((link) => targets.get(link.start) ?? link.target);
  const urls = before.urls.map(({ url }, node) => urlsAt.get(node) ?? url);
  return (
    after.wikilinks.length === wikilinks.length &&
    after.wikilinks.every((link, i) => link.target === wikilinks[i]) &&
    after.urls.length === urls.length &&
    after.urls.every((found, i) => found.url === urls[i] && found.image === before.urls[i]?.image)
  );
}
