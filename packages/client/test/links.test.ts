import { describe, expect, it } from 'vite-plus/test';
import {
  findLinks,
  findWikilinks,
  placedWikilinks,
  resolveWikilinks,
  rewriteAddressLinks,
  tableWikilinks,
} from '../src/index.ts';

const targets = (markdown: string) => findWikilinks(markdown).map((link) => link.source);

describe('finding wikilinks', () => {
  it('leaves inert forms, code, HTML and frontmatter alone', () => {
    expect(targets('![[Page embed]] [[Page#^block]] [[]] [[#]]')).toEqual([]);
    expect(targets('    [[indented]]\n\n<div>\n[[html]]\n</div>\n\n[[after]]')).toEqual([
      '[[after]]',
    ]);
    expect(targets('`[[inline]]` ``[[`double`]]`` [[after]]')).toEqual(['[[after]]']);
    expect(targets('```md\n[[fenced]]\n```\n~~~\n[[tilde]]\n~~~\n[[after]]')).toEqual([
      '[[after]]',
    ]);
    expect(targets('```\n[[never closed]]')).toEqual([]);
    expect(targets('---\nlink: "[[in frontmatter]]"\n---\n[[body]]')).toEqual(['[[body]]']);
    expect(targets('---\r\nlink: "[[crlf]]"\r\n...\r\n[[body]]')).toEqual(['[[body]]']);
    // Without a closing line, a leading --- is ordinary Markdown.
    expect(targets('---\n[[not frontmatter]]')).toEqual(['[[not frontmatter]]']);
  });
});

describe('resolving wikilinks', () => {
  const pages = [
    { id: 'p-plan', title: 'Plan', folders: ['Home', 'Shared'] },
    { id: 'p-dup-1', title: 'Notes', folders: ['Work'] },
    { id: 'p-dup-2', title: 'notes', folders: ['Home'] },
    { id: 'p-unreadable', title: null, folders: [] },
  ];
  const resolve = (markdown: string, attachments: { id: string; name: string }[] = []) =>
    resolveWikilinks(findWikilinks(markdown), { pages, selfId: 'p-self', attachments }).map(
      ({ source, status, targets }) => [source, status, targets],
    );

  it('matches titles case-insensitively, and reports missing and ambiguous links', () => {
    expect(resolve('[[plan]] [[Nowhere]] [[Notes]]')).toEqual([
      ['[[plan]]', 'resolved', ['p-plan']],
      ['[[Nowhere]]', 'missing', []],
      ['[[Notes]]', 'ambiguous', ['p-dup-1', 'p-dup-2']],
    ]);
  });
});

describe('the wikilinks a link table holds', () => {
  const PAGE = [
    '---',
    'goes_with: "[[Tomato soup]]" # side',
    "after: '[[Folder/Pie|the pie]]'",
    'list: ["[[Not a value]]"]',
    'text: "see [[Not alone]]"',
    '---',
    'With [[Bread]] in `=[[Garlic bread]].cook_time` and `` = [[Pie]].x ``.',
    '',
    '`[[Code]]`, `=[[Head#ing]].x`, `=Plain`.',
    '',
    '```',
    '`=[[Fenced]].x`',
    '```',
    '',
  ].join('\n');

  it('are the properties’ links, then the body’s and the pages its references name, in order', () => {
    const links = tableWikilinks(PAGE);
    expect(links.map(({ target, property }) => [target, property])).toEqual([
      ['Tomato soup', 'goes_with'],
      ['Folder/Pie', 'after'],
      ['Bread', undefined],
      ['Garlic bread', undefined],
      ['Pie', undefined],
    ]);
    for (const link of links) {
      const written = PAGE.slice(link.start, link.end);
      if (link.property) expect(written).toContain(link.source);
      else expect(written).toBe(link.source);
    }
    expect(links[0]?.source).toBe('[[Tomato soup]]');
    expect(PAGE.slice(links[0]?.start, links[0]?.end)).toBe('"[[Tomato soup]]"');
    expect(links[1]?.shown).toBe('the pie');
  });

  it('leave the body’s links as readers show them', () => {
    expect(placedWikilinks(PAGE).map((link) => link.target)).toEqual(['Bread']);
    expect(findWikilinks(PAGE).map((link) => link.target)).toEqual(['Bread']);
  });

  it('are none without `[[`, or in a block that doesn’t read', () => {
    expect(tableWikilinks('`=servings`')).toEqual([]);
    expect(tableWikilinks('---\n- "[[A]]"\n---\n`=[[B]].x`').map((link) => link.target)).toEqual([
      'B',
    ]);
  });
});

describe('rewriting links to page and folder addresses', () => {
  const copies = new Map([
    ['plan', 'copy'],
    ['notes', 'notes-copy'],
  ]);
  const copied = (node: { spaceId: string; nodeId: string }) => {
    const copy = node.spaceId === 'lib' ? copies.get(node.nodeId) : undefined;
    return copy ? { spaceId: 'board', nodeId: copy } : null;
  };

  it('points each link to a copied page at its copy, keeping the rest as written', () => {
    const markdown = [
      '---',
      'link: /s/lib/p/plan',
      '---',
      '[/s/lib/p/plan](https://wiki.example/s/lib/p/plan#goals) and <https://wiki.example/s/lib/p/plan>',
      '[by reference][ref], [another](/s/lib/p/other), `/s/lib/p/plan`',
      '',
      '[ref]: /s/lib/p/plan',
    ].join('\n');
    expect(rewriteAddressLinks(markdown, copied)).toBe(
      [
        '---',
        'link: /s/lib/p/plan',
        '---',
        '[/s/lib/p/plan](https://wiki.example/s/board/p/copy#goals) and <https://wiki.example/s/board/p/copy>',
        '[by reference][ref], [another](/s/lib/p/other), `/s/lib/p/plan`',
        '',
        '[ref]: /s/board/p/copy',
      ].join('\n'),
    );
  });

  it('points a link to a copied folder at its copy, and says which it can’t', () => {
    const markdown = [
      '[Notes](/s/lib/f/notes) and [its page](/s/lib/p/notes), [other](/s/lib/f/other)',
      '[escaped](/s/lib/f/not&#101;s) [by reference][notes]',
      '',
      '[notes]: https://wiki.example/s/lib/f/notes#top',
    ].join('\n');
    expect(rewriteAddressLinks(markdown, copied)).toBe(
      [
        '[Notes](/s/board/f/notes-copy) and [its page](/s/board/p/notes-copy), [other](/s/lib/f/other)',
        '[escaped](/s/lib/f/not&#101;s) [by reference][notes]',
        '',
        '[notes]: https://wiki.example/s/board/f/notes-copy#top',
      ].join('\n'),
    );
    const { pageLinks, folderLinks } = findLinks(markdown);
    expect(pageLinks.map((link) => [link.pageId, link.plain])).toEqual([['notes', true]]);
    expect(folderLinks.map((link) => [link.text, link.folderId, link.plain])).toEqual([
      ['Notes', 'notes', true],
      ['other', 'other', true],
      ['escaped', 'notes', false],
      ['by reference', 'notes', true],
    ]);
  });
});
