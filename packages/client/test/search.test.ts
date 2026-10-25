import { describe, expect, it } from 'vite-plus/test';
import {
  hasTag,
  markdownNodes,
  parseMarkdown,
  propertyData,
  SearchIndex,
  searchTerms,
  searchText,
} from '../src/index.ts';
import { growth } from './support/timing.ts';

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

describe('properties in a search index', () => {
  const held = (markdown: string) => {
    const index = new SearchIndex<string>();
    index.add('page', { title: 'Page', markdown });
    return index.pages()[0]?.properties;
  };

  it('keeps each page’s properties beside its text, from its frontmatter', () => {
    const markdown = '---\ntags: [soup, Winter]\nservings: 4\n---\nBean soup.';
    expect(held(markdown)).toEqual([
      { key: 'tags', type: 'list', value: ['soup', 'Winter'] },
      { key: 'servings', type: 'number', value: 4 },
    ]);
    // The block is still searched as text.
    const index = new SearchIndex<string>();
    index.add('page', { title: 'Page', markdown });
    expect(index.search('winter').map(({ doc }) => doc)).toEqual(['page']);
  });

  it('reads properties only from a block the page starts with, not from its text', () => {
    expect(held('Bean soup.\n\n---\ntags: soup\n---\n')).toEqual([]);
    expect(held('tags: soup')).toEqual([]);
    expect(held('---\n- not\n- a map\n---\nText')).toEqual([]);
    expect(held('---\ntags: [soup\n---\nText')).toEqual([]);
    const index = new SearchIndex<string>();
    index.addText('kept', { title: 'Kept', text: 'kept text' });
    expect(index.pages()[0]?.properties).toEqual([]);
  });

  it('takes time linear in the block, which is read up to 64 KiB', () => {
    const block = (lines: number) =>
      `---\n${Array.from({ length: lines }, (_, i) => `key_${i}: [a, "b ${i}", 3]`).join('\n')}\n---\nText`;
    const index = (markdown: string) =>
      new SearchIndex<string>().add('page', { title: '', markdown });
    // 7 times the lines; quadratic would be 49.
    expect(growth(index, block(300), block(2100))).toBeLessThan(20);
    expect(held(block(2100))).toHaveLength(2100);
    expect(held(block(4000))).toEqual([]);
  });
});

describe('tags', () => {
  const tagged = (yaml: string, tag: string) => hasTag(propertyData(`---\n${yaml}\n---\n`), tag);

  it('are a tags list holding the tag, or a tags value that is it, whatever its case and accents', () => {
    expect(tagged('tags: [soup, winter]', 'soup')).toBe(true);
    expect(tagged('tags:\n  - Soup\n  - winter', 'SOUP')).toBe(true);
    expect(tagged('tags: soup', 'soup')).toBe(true);
    expect(tagged('tags: Crème', 'creme')).toBe(true);
    expect(tagged('tags: [2024]', '2024')).toBe(true);
    expect(tagged('tags: [[soup], winter]', 'soup')).toBe(true);
    expect(tagged('tags: "#soup"', 'soup')).toBe(true);
    expect(tagged('tags: soup', '#soup')).toBe(true);
    // The key is named as a reference names it.
    expect(tagged('Tags: soup', 'soup')).toBe(true);
  });

  it('match only a whole tag, in tags', () => {
    expect(tagged('tags: [soups]', 'soup')).toBe(false);
    expect(tagged('tags: soup, winter', 'soup')).toBe(false);
    expect(tagged('category: soup', 'soup')).toBe(false);
    expect(tagged('tags:', 'soup')).toBe(false);
    expect(tagged('tags: [~, soup]', '')).toBe(false);
    expect(tagged('tags: [~]', 'null')).toBe(false);
    // The first key a reference would take is the one read.
    expect(tagged('tags: winter\nTags: soup', 'soup')).toBe(false);
    expect(hasTag([], 'soup')).toBe(false);
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
