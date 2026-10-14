import { describe, expect, it } from 'vite-plus/test';
import { findWikilinks, resolveWikilinks } from '../src/index.ts';

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
