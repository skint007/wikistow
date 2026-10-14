// The export's paths and links, for random trees: whatever the titles,
// folder and attachment names, every path is a safe relative one inside the
// export, unique case-insensitively, and every link rewritten names the
// file written for its page or attachment.
import { posix } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  AttachmentId,
  EXPORT_NAME_BYTES,
  foldName,
  markdownNodes,
  newPayload,
  parseMarkdown,
  placedWikilinks,
  planExport,
  resolveWikilinks,
  splitFrontmatter,
  type AttachmentRef,
  type ExportPlan,
  type ExportSpace,
} from '../src/index.ts';

/** mulberry32: the same seed, the same trees. */
function random(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

// Pieces names are made of: ordinary, look-alike, unsafe and reserved ones.
const PIECES = [
  'a',
  'Notes',
  'notes',
  'NOTES',
  'Plan',
  'é',
  cp(0x65, 0x301),
  'ß',
  'SS',
  cp(0x130),
  cp(0x131),
  '日本',
  cp(0x1f600),
  cp(0x1f469, 0x200d, 0x1f467),
  ' ',
  '  ',
  '.',
  '..',
  '/',
  '\\',
  '<',
  '>',
  ':',
  '"',
  '|',
  '?',
  '*',
  '#',
  '^',
  '[',
  ']',
  '`',
  cp(0),
  cp(7),
  cp(0x1f),
  cp(0x7f),
  cp(0x85),
  cp(0x202e),
  cp(0x2028),
  '\ud800',
  'CON',
  'con',
  'Nul',
  'COM1',
  'lpt9',
  'aux.txt',
  'CONIN$',
  'conout$',
  'attachments',
  'Attachments',
  ' (2)',
  '(3)',
  '.md',
  '.png',
  '.PNG',
  'x'.repeat(120),
  'é'.repeat(90),
  cp(0x1f600).repeat(40),
  `.${'x'.repeat(16)}`,
  `.${cp(0x1f600).repeat(16)}`,
  `.${'日'.repeat(15)} `,
];

// Long names given over and over, so the suffixes pile up on names at the cap.
const LONG = ['é'.repeat(150), `${'x'.repeat(250)}.${cp(0x1f600).repeat(16)}`, 'Notes'];

const ref = (id: string, name: string): AttachmentRef => ({
  id: AttachmentId.parse(id),
  name,
  mediaType: 'image/png',
  size: 1,
  key: 'AAAA',
  blobHash: 'A'.repeat(43),
});

function randomSpaces(seed: number): ExportSpace[] {
  const r = random(seed);
  const name = () =>
    r.next() < 0.15
      ? r.pick(LONG)
      : Array.from({ length: r.int(5) }, () => r.pick(PIECES)).join('');
  const spaces = r.next() < 0.2 ? 1 + r.int(3) : 1;
  return Array.from({ length: spaces }, (_, s) => {
    const folders = Array.from({ length: r.int(8) }, (_, i) => ({
      id: `s${s}f${i}`,
      parentId: i > 0 && r.next() < 0.6 ? `s${s}f${r.int(i)}` : null,
      name: r.next() < 0.1 ? null : name(),
    }));
    const pages = Array.from({ length: 1 + r.int(12) }, (_, i) => ({
      id: `s${s}p${i}`,
      parentId: folders.length > 0 && r.next() < 0.7 ? r.pick(folders).id : null,
      title: name(),
      attachments: Array.from({ length: r.int(4) }, (_, k) =>
        ref(`s${s}p${i}a${k}`, r.next() < 0.5 ? `${name()}.png` : name()),
      ),
    }));
    const above = (parentId: string | null): string[] => {
      const folder = folders.find((f) => f.id === parentId);
      return folder ? [...above(folder.parentId), folder.name ?? ''] : [];
    };
    const linked = pages.map((page) => {
      const parts = Array.from({ length: r.int(8) }, () => {
        const other = r.pick(pages);
        const file = page.attachments.length > 0 ? r.pick(page.attachments) : null;
        switch (r.int(9)) {
          case 0:
            return `[[${other.title}]]`;
          case 1:
            return `[[${other.title}|shown ${r.int(9)}]]`;
          case 2:
            return `[[${other.title}#Part ${r.int(9)}]]`;
          case 3:
            return `| x |\n| - |\n| [[${other.title}]] |\n`;
          case 4:
            return file ? `![[${file.name}]]` : `[[#Top]]`;
          case 5:
            return file ? `![[${file.name}|${r.int(400)}]]` : `[[${name()}]]`;
          case 6:
            return file
              ? `[file](attachment:${file.id})`
              : `[[${above(other.parentId).at(-1) ?? ''}/${other.title}]]`;
          case 7:
            return file ? `<attachment:${file.id}>` : `<https://example.com/${r.int(9)}>`;
          default:
            return file ? `![alt](attachment:${file.id} "title")` : 'plain';
        }
      });
      const newline = r.next() < 0.3 ? '\r\n' : '\n';
      const frontmatter =
        r.next() < 0.3 ? `---${newline}tags: [[${name()}]]${newline}---${newline}` : '';
      return {
        id: page.id,
        parentId: page.parentId,
        payload: newPayload({
          title: page.title,
          markdown: frontmatter + parts.join(`${newline}${newline}`),
          attachments: page.attachments,
        }),
      };
    });
    return {
      dir: spaces === 1 ? null : name(),
      folders,
      pages: linked,
      linkable: pages.map((p) => ({ id: p.id, title: p.title, folders: above(p.parentId) })),
    };
  });
}

const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])$/i;
const FORBIDDEN = new Set('/\\<>:"|?*#^[]`');
const unsafe = (char: string) => {
  const c = char.codePointAt(0) ?? 0;
  return (
    FORBIDDEN.has(char) ||
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    [0x61c, 0x200e, 0x200f].includes(c) ||
    (c >= 0x2028 && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
};

/** Why `path` isn't a safe relative path, or null. */
function unsafePath(path: string): string | null {
  if (path === '' || path.startsWith('/')) return 'not relative';
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return `segment ${segment}`;
    if (!segment.isWellFormed()) return 'not well-formed';
    if (segment !== segment.normalize('NFC')) return 'not NFC';
    if (Array.from(segment).some(unsafe)) return 'unsafe character';
    if (/^[\s.]|[\s.]$/u.test(segment)) return 'dot or space at an end';
    if (new TextEncoder().encode(segment).length > EXPORT_NAME_BYTES) return 'too long';
    const base = segment.split('.')[0]?.replace(/ +$/, '') ?? '';
    if (RESERVED.test(base.replace(/[\u00b9\u00b2\u00b3]$/u, '1'))) return 'reserved';
  }
  return null;
}

/**
 * The one file Obsidian takes a wikilink's target for, in a vault at the
 * export's top: the file at that path, else the one file of that name.
 */
function obsidianFile(target: string, files: readonly string[]): string | null {
  const key = (path: string) => foldName(path.endsWith('.md') ? path.slice(0, -3) : path);
  const wanted = foldName(target);
  const exact = files.filter((f) => key(f) === wanted);
  if (exact.length > 0) return exact.length === 1 ? (exact[0] ?? null) : null;
  if (wanted.includes('/')) return null;
  const named = files.filter((f) => key(f).endsWith(`/${wanted}`));
  return named.length === 1 ? (named[0] ?? null) : null;
}

const urlsOf = (markdown: string) => {
  const urls: string[] = [];
  for (const node of markdownNodes(parseMarkdown(splitFrontmatter(markdown).body))) {
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      urls.push(node.url);
    }
  }
  return urls;
};

function check(spaces: ExportSpace[], plan: ExportPlan) {
  const files = plan.files.map((f) => f.path);
  const all = [...plan.dirs, ...files];
  for (const path of all) expect(unsafePath(path), path).toBeNull();
  // Unique case-insensitively, files and folders together.
  expect(new Set(all.map(foldName)).size).toBe(all.length);
  // Each in a folder the export makes, made before it.
  plan.dirs.forEach((dir, i) => {
    const parent = posix.dirname(dir);
    if (parent !== '.') expect(plan.dirs.slice(0, i)).toContain(parent);
  });
  for (const path of files) {
    const parent = posix.dirname(path);
    if (parent !== '.') expect(plan.dirs).toContain(parent);
  }
  const pathOf = new Map(
    plan.files.map((f) => [`${f.space}/${f.pageId}/${f.kind === 'page' ? '' : f.ref.id}`, f.path]),
  );
  for (const file of plan.files) {
    if (file.kind !== 'page') continue;
    const space = spaces[file.space];
    const page = space?.pages.find((p) => p.id === file.pageId);
    if (!space || !page) throw new Error('A page file for no page');
    const dir = posix.dirname(file.path) === '.' ? '' : posix.dirname(file.path);
    const before = placedWikilinks(page.payload.markdown);
    const after = placedWikilinks(file.markdown);
    expect(after.length, file.markdown).toBe(before.length);
    expect(splitFrontmatter(file.markdown).frontmatter).toBe(
      splitFrontmatter(page.payload.markdown).frontmatter,
    );
    const resolved = resolveWikilinks(before, {
      pages: space.linkable,
      selfId: page.id,
      attachments: page.payload.attachments,
    });
    before.forEach((link, i) => {
      const out = after[i];
      const found = resolved[i];
      if (!out || !found) throw new Error('A link went missing');
      const [id = ''] = found.targets;
      if (found.status !== 'resolved' || link.target === '') {
        expect(out.source).toBe(link.source);
      } else if (link.embed) {
        const at = pathOf.get(`${file.space}/${page.id}/${id}`);
        expect(posix.join(dir, out.target), out.source).toBe(at);
        expect(out.shown).toBe(link.shown);
      } else {
        const at = pathOf.get(`${file.space}/${id}/`);
        expect(obsidianFile(out.target, files), out.source).toBe(at);
        expect(out.heading).toBe(link.heading);
        if (link.shown !== null) expect(out.shown).toBe(link.shown);
      }
    });
    const urls = urlsOf(page.payload.markdown);
    const written = urlsOf(file.markdown);
    expect(written.length).toBe(urls.length);
    urls.forEach((url, i) => {
      const id = url.startsWith('attachment:') ? url.slice('attachment:'.length) : null;
      const at = id === null ? undefined : pathOf.get(`${file.space}/${page.id}/${id}`);
      if (at === undefined) expect(written[i]).toBe(url);
      else expect(posix.join(dir, decodeURIComponent(written[i] ?? ''))).toBe(at);
    });
  }
}

describe('export paths, for random trees', () => {
  it('are safe, unique, and what every link names', { timeout: 120_000 }, () => {
    for (let seed = 1; seed <= 200; seed++) {
      const spaces = randomSpaces(seed);
      const plan = planExport(spaces);
      try {
        check(spaces, plan);
      } catch (error) {
        throw new Error(`Seed ${seed}`, { cause: error });
      }
    }
  });
});
