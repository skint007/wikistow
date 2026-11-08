import { describe, expect, it } from 'vite-plus/test';
import {
  AttachmentId,
  LINKS_NAMESPACE,
  newPayload,
  placedWikilinks,
  planExport,
  type ExportSpace,
  type PagePayload,
} from '../src/index.ts';

const payload = (
  title: string,
  markdown = '',
  more: { links?: Record<string, string> } = {},
): PagePayload =>
  newPayload({
    title,
    markdown,
    extensions: more.links
      ? {
          [LINKS_NAMESPACE]: {
            format: 1,
            links: Object.entries(more.links).map(([key, pageId]) => ({ key, pageId })),
          },
        }
      : {},
  });

type Page = { id: string; parentId?: string | null; payload: PagePayload };

/**
 * One space: folders by ID and name, and pages. Links resolve against
 * every page listed in `linkable`, by default those exported.
 */
function space(
  folders: { id: string; parentId?: string | null; name: string | null }[],
  pages: Page[],
  linkable?: ExportSpace['linkable'],
): ExportSpace {
  const named = folders.map((f) => ({ ...f, parentId: f.parentId ?? null }));
  const above = (parentId: string | null, seen = new Set<string>()): string[] => {
    const folder = named.find((f) => f.id === parentId && !seen.has(f.id));
    return folder ? [...above(folder.parentId, seen.add(folder.id)), folder.name ?? ''] : [];
  };
  return {
    dir: null,
    folders: named,
    pages: pages.map((p) => ({ ...p, parentId: p.parentId ?? null })),
    linkable:
      linkable ??
      pages.map((p) => ({ id: p.id, title: p.payload.title, folders: above(p.parentId ?? null) })),
  };
}

const exported = (spaces: ExportSpace[]) => {
  const plan = planExport(spaces);
  const files = Object.fromEntries(
    plan.files.map((file) => [file.path, file.kind === 'page' ? file.markdown : file.ref.id]),
  );
  return { dirs: plan.dirs, files };
};

/** The one page's Markdown as exported, next to `others`. */
function markdownOf(page: Page, others: Page[] = [], folders: Parameters<typeof space>[0] = []) {
  const file = planExport([space(folders, [page, ...others])]).files.find(
    (f) => f.pageId === page.id,
  );
  return file?.kind === 'page' ? file.markdown : undefined;
}

describe('planning an export', () => {
  it('mirrors the tree, one file per page', () => {
    const { dirs, files } = exported([
      space(
        [
          { id: 'f-home', name: 'Home' },
          { id: 'f-net', parentId: 'f-home', name: 'Network' },
          { id: 'f-empty', name: 'Empty' },
        ],
        [
          { id: 'p-top', payload: payload('Top', 'top') },
          { id: 'p-router', parentId: 'f-net', payload: payload('Router', 'router') },
        ],
      ),
    ]);
    expect(dirs).toEqual(['Empty', 'Home', 'Home/Network']);
    expect(files).toEqual({ 'Top.md': 'top', 'Home/Network/Router.md': 'router' });
  });
});

describe('rewriting links', () => {
  const plan = { id: 'p-plan', payload: payload('Plan') };

  it('follows the link table to a renamed page, and names it by its current title', () => {
    const renamed = { id: 'p-new', payload: payload('Roadmap') };
    const page = {
      id: 'p-self',
      payload: payload('Self', '[[Old plan]], [[old plan|ours]], [[Old plan#Q3]]', {
        links: { 'old plan': 'p-new' },
      }),
    };
    expect(markdownOf(page, [renamed])).toBe('[[Roadmap]], [[Roadmap|ours]], [[Roadmap#Q3]]');
  });

  it('leaves a link to a page outside the export as written', () => {
    const page = { id: 'p-self', payload: payload('Self', '[[Plan]] [[Elsewhere]]') };
    const linkable = [
      { id: 'p-self', title: 'Self', folders: [] },
      { id: 'p-plan', title: 'Plan', folders: [] },
      { id: 'p-out', title: 'Elsewhere', folders: ['Not exported'] },
    ];
    const files = planExport([space([], [page, plan], linkable)]).files;
    expect(files.find((f) => f.pageId === 'p-self')).toMatchObject({
      markdown: '[[Plan]] [[Elsewhere]]',
    });
  });

  it('rewrites just the wikilinks the reader finds', () => {
    const markdown = [
      '![see [[plan]]](x.png) ![[[plan]]][ref] ![a ![b [[plan]]](c)](d)',
      '[a [[plan]] b](https://x) `[[plan]]` <span title="[[plan]]">[[plan]]</span>',
      '| [[plan]] | ![a [[plan]]](y) |\n| - | - |',
      '> [[plan]] [^1]\n\n[^1]: [[plan]]',
      '[ref]: https://x',
    ].join('\n\n');
    const page = { id: 'p-self', payload: payload('Self', markdown) };
    const found = placedWikilinks(markdown);
    expect(found).toHaveLength(5);
    let expected = markdown;
    for (const { start, end } of found.toReversed()) {
      expected = `${expected.slice(0, start)}[[Plan]]${expected.slice(end)}`;
    }
    expect(markdownOf(page, [plan])).toBe(expected);
  });

  // Parses about 100 KB twice, which takes several seconds on a slow runner.
  it('reads a long page in pieces as the reader reads it whole', () => {
    // Blocks that run across where the pieces are cut, every 16 KB or so.
    const filler = (kb: number) => 'Words to read past, [[plan]] and *more*.\r\n'.repeat(kb * 25);
    const markdown = [
      filler(15),
      '```\r\n',
      '[[plan]] in a fence\r\n'.repeat(400),
      '```\r\n\r\n| a | b |\r\n| - | - |\r\n',
      '| [[plan]] | x |\r\n'.repeat(1_000),
      '\r\n',
      '- [[plan]] in a list\r\n  going on\r\n'.repeat(600),
      '\r\n',
      filler(20),
    ].join('');
    expect(markdown.length).toBeGreaterThan(64 * 1024);
    const page = { id: 'p-self', payload: payload('Self', markdown) };
    let expected = markdown;
    for (const { start, end } of placedWikilinks(markdown).toReversed()) {
      expected = `${expected.slice(0, start)}[[Plan]]${expected.slice(end)}`;
    }
    expect(expected).toContain('[[plan]] in a fence');
    expect(markdownOf(page, [plan])).toBe(expected);
  }, 30_000);
});

describe('writing Markdown links', () => {
  const file = (name: string, mediaType: string) => ({
    id: AttachmentId.parse(`a-${name.replace(/\W/g, '')}`),
    name,
    mediaType,
    size: 1,
    key: 'AAAA',
    blobHash: 'A'.repeat(43),
  });

  it('links each page’s file by its path from here, to the heading GitHub names', () => {
    const photo = file('photo.png', 'image/png');
    const manual = file('manual.pdf', 'application/pdf');
    const markdown = [
      '[[Plan]], [[plan|the plan]], [[Plan#Next steps]], [[#What’s new?]], [[Plan#Pros & cons]]',
      '[see [[Plan]]](https://example.com)',
      '[[A/B]] [[Work/Notes]] [[Home/Notes]]',
      '| [[Plan|in a table]] |\n| - |',
      '![[photo.png|300]] ![[manual.pdf]] ![[Plan]] [[Plan#^block]] [[Nowhere]] [[Elsewhere]]',
    ].join('\n\n');
    const self = {
      id: 'p-self',
      parentId: 'f-home',
      payload: {
        // The link table picks the second of two pages that `Work/Notes` names.
        ...payload('Self', markdown, { links: { 'work/notes': 'p-notes-2' } }),
        attachments: [photo, manual],
      },
    };
    const pages = [
      self,
      { id: 'p-plan', parentId: 'f-work', payload: payload('Plan') },
      // A name no file system takes, and one used twice in a folder.
      { id: 'p-slash', parentId: 'f-home', payload: payload('A/B') },
      { id: 'p-notes', parentId: 'f-work', payload: payload('Notes') },
      { id: 'p-notes-2', parentId: 'f-work', payload: payload('notes') },
      { id: 'p-home-notes', parentId: 'f-home', payload: payload('Notes') },
    ];
    const folders = [
      { id: 'f-home', name: 'Home' },
      { id: 'f-work', name: 'Work' },
    ];
    const listed = space(folders, pages);
    const linkable = [
      ...listed.linkable,
      { id: 'p-out', title: 'Elsewhere', folders: ['Not exported'] },
    ];
    const plan = planExport([{ ...listed, linkable }], { links: 'markdown' });
    const paths = plan.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'Home/A_B.md',
      'Home/Notes.md',
      'Home/Self.md',
      'Work/Notes.md',
      'Work/Plan.md',
      'Work/notes (2).md',
      'attachments/manual.pdf',
      'attachments/photo.png',
    ]);
    const written = plan.files.find((f) => f.pageId === 'p-self' && f.kind === 'page');
    expect(written).toMatchObject({
      markdown: [
        '[Plan](../Work/Plan.md), [the plan](../Work/Plan.md), ' +
          '[Plan › Next steps](../Work/Plan.md#next-steps), [What’s new?](#whats-new), ' +
          '[Plan › Pros \\& cons](../Work/Plan.md#pros--cons)',
        // A link can't hold another, so this one stays.
        '[see [[Plan]]](https://example.com)',
        '[A/B](A_B.md) [notes](../Work/notes%20%282%29.md) [Notes](Notes.md)',
        '| [in a table](../Work/Plan.md) |\n| - |',
        '![photo.png](../attachments/photo.png) [manual.pdf](../attachments/manual.pdf) ' +
          '![[Plan]] [[Plan#^block]] [[Nowhere]] [[Elsewhere]]',
      ].join('\n\n'),
      wikilinks: 5,
    });
    const twice = { id: 'p-twice', parentId: 'f-work', payload: payload('Twice', '[[notes]]') };
    const other = planExport([space(folders, [...pages, twice])], { links: 'markdown' });
    // `notes` names two pages, so it stays a wikilink; one link per page is enough here.
    expect(other.files.find((f) => f.pageId === 'p-twice')).toMatchObject({
      markdown: '[[notes]]',
      wikilinks: 1,
    });
  });

  it('percent-encodes a path as attachment links are, and leaves wikilinks alone by default', () => {
    const page = { id: 'p-self', payload: payload('Self', '[[Q3 (draft)]]') };
    const target = { id: 'p-q3', payload: payload('Q3 (draft)') };
    const markdown = (links: 'wiki' | 'markdown') =>
      planExport([space([], [page, target])], { links }).files.find((f) => f.pageId === page.id);
    expect(markdown('markdown')).toMatchObject({ markdown: '[Q3 (draft)](Q3%20%28draft%29.md)' });
    expect(markdown('wiki')).toMatchObject({ markdown: '[[Q3 (draft)]]' });
    expect(markdown('wiki')).not.toHaveProperty('wikilinks');
  });
});
