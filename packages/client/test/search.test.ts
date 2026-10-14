import { describe, expect, it } from 'vite-plus/test';
import {
  markdownNodes,
  parseMarkdown,
  SearchIndex,
  searchTerms,
  searchText,
} from '../src/index.ts';

function indexOf(pages: Record<string, string>) {
  const index = new SearchIndex<string>();
  for (const [title, markdown] of Object.entries(pages)) index.add(title, { title, markdown });
  return index;
}

const found = (index: SearchIndex<string>, query: string) =>
  index.search(query).map(({ doc }) => doc);

describe('a search index', () => {
  const index = indexOf({
    'Backup procedure': 'How we copy the photos to the NAS every night.',
    'Network notes': '---\ntags: [router, backup]\n---\nThe router lives in the hall.',
    Recipes: 'Bean soup. Make a backup of the starter before feeding it.',
    Garden: 'Tomatoes and beans along the fence.',
  });

  it('finds pages holding every term, the last one also as a prefix', () => {
    expect(found(index, 'beans')).toEqual(['Garden']);
    expect(found(index, 'bean')).toEqual(['Recipes', 'Garden']);
    expect(found(index, 'beans fen')).toEqual(['Garden']);
    // Only the last term matches as a prefix.
    expect(found(index, 'bea fence')).toEqual([]);
    expect(found(index, 'BACKUP proc').length).toBe(1);
    expect(found(index, '')).toEqual([]);
    expect(found(index, '  ,. ')).toEqual([]);
    expect(found(index, 'nothing-like-this')).toEqual([]);
  });

  it('matches accented and unaccented text either way, and CJK by character', () => {
    const accents = indexOf({
      Café: 'Crème brûlée at the café.',
      Notes: '日本語のテキストです',
    });
    expect(found(accents, 'creme brulee')).toEqual(['Café']);
    expect(found(accents, 'CAFÉ')).toEqual(['Café']);
    expect(found(accents, 'テキスト')).toEqual(['Notes']);
    expect(found(accents, '日本')).toEqual(['Notes']);
    expect(found(accents, '中国')).toEqual([]);
  });
});

describe('Markdown as search text', () => {
  const words = (text: string) => searchTerms(text).map(({ term }) => term);
  // The words a reader shows: the parse's text, as in markdown.tsx.
  const shown = (markdown: string) =>
    words(
      [...markdownNodes(parseMarkdown(markdown))]
        .flatMap((node) => (node.type === 'text' ? [node.value] : []))
        .join(' '),
    );

  it('reads a numbered line as a list item only where the reader does', () => {
    for (const markdown of [
      // In a quote opened after a list marker or footnote label: text.
      '- > The year was\n  > 2024. Good year',
      '[^1]: > We moved\n    > 1998. Then left',
      // In a quote whose lines mix `> ` and `>`: text.
      '> We moved in\n>2019. Then left',
      '>We moved in\n> 2019. Then left',
      // In a quote opened straight after a paragraph: text.
      'The manual says:\n> 2. Remove the cover.',
      // After a sibling item, in a quote or not: a nested item.
      '- Tools\n- 2. Hammer',
      '> - Tools\n> - 2. Hammer',
      '1. Tools\n2. 3. Hammer',
    ]) {
      expect(words(searchText(markdown)), markdown).toEqual(shown(markdown));
    }
  });
});
