import { describe, expect, it } from 'vite-plus/test';
import {
  hasTag,
  markdownNodes,
  matchesFilter,
  parseMarkdown,
  parseSearch,
  propertyData,
  SearchIndex,
  searchFilter,
  searchTerms,
  searchText,
} from '../src/index.ts';
import { cpuTime, growth } from './support/timing.ts';

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
    // The key is named as a reference names it, and Obsidian's older `tag` is tags too.
    expect(tagged('Tags: soup', 'soup')).toBe(true);
    expect(tagged('tag: [soup]', 'soup')).toBe(true);
    expect(tagged('tags: winter\ntag: soup', 'soup')).toBe(true);
    // `tags:` is a tag filter too.
    expect(
      matchesFilter(propertyData('---\ntag: "#Soup"\n---\n'), { key: 'tags', value: 'soup' }),
    ).toBe(true);
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

describe('filters in a query', () => {
  it('are a name, a colon and a value, the value in quotes if it has spaces', () => {
    expect(parseSearch('tag:soup')).toEqual({
      words: '',
      filters: [{ key: 'tag', value: 'soup' }],
    });
    expect(parseSearch('bean status:"in progress" tag:Soup soup')).toEqual({
      words: 'bean soup',
      filters: [
        { key: 'status', value: 'in progress' },
        { key: 'tag', value: 'Soup' },
      ],
    });
    expect(parseSearch('cook_time:40 cook-time:"4 0"').filters).toEqual([
      { key: 'cook_time', value: '40' },
      { key: 'cook-time', value: '4 0' },
    ]);
    expect(parseSearch('note:"say \\"hi\\" \\\\ bye"').filters).toEqual([
      { key: 'note', value: 'say "hi" \\ bye' },
    ]);
    // Any other backslash is itself.
    expect(parseSearch('path:"C:\\Users\\n"').filters).toEqual([
      { key: 'path', value: 'C:\\Users\\n' },
    ]);
    // A quote not closed runs to the end, as one being typed does.
    expect(parseSearch('status:"in prog').filters).toEqual([{ key: 'status', value: 'in prog' }]);
  });

  it('leave words, quoted words and half-typed filters be', () => {
    expect(parseSearch('tag:')).toEqual({ words: '', filters: [] });
    expect(parseSearch('tag:#')).toEqual({ words: '', filters: [] });
    expect(parseSearch('tags:"#"')).toEqual({ words: '', filters: [] });
    // Only at the end: elsewhere, a name and a colon are words.
    expect(parseSearch('Re: dinner tag:')).toEqual({ words: 'Re: dinner', filters: [] });
    expect(parseSearch('soup status:""')).toEqual({ words: 'soup', filters: [] });
    expect(parseSearch('"10:30" "https://example.com" (tag:soup) :x')).toEqual({
      words: '"10:30" "https://example.com" (tag:soup) :x',
      filters: [],
    });
    expect(parseSearch('  ').filters).toEqual([]);
    // A time and a web address are words, unquoted too.
    expect(parseSearch('10:30 https://example.com/recipe tag:soup')).toEqual({
      words: '10:30 https://example.com/recipe',
      filters: [{ key: 'tag', value: 'soup' }],
    });
    expect(parseSearch('url:"//example.com"').filters).toEqual([
      { key: 'url', value: '//example.com' },
    ]);
  });

  it('are read in time linear in the query', () => {
    const query = (n: number) =>
      `${'tag:soup word "quoted words" '.repeat(n)}status:"${'x'.repeat(n)}`;
    // 8 times the query; quadratic would be 64.
    expect(growth((q) => parseSearch(q), query(2000), query(16_000))).toBeLessThan(24);
    expect(cpuTime(() => parseSearch(`a${'_'.repeat(200_000)}`)).ms).toBeLessThan(500);
    // Names with no value, before a long run of spaces.
    const empty = (n: number) => `${'a: '.repeat(n)}z${' '.repeat(10 * n)}`;
    expect(growth((q) => parseSearch(q), empty(2000), empty(16_000))).toBeLessThan(24);
  });

  it('can be written for a key and value, quoted where they need it', () => {
    expect(searchFilter('tag', 'soup')).toBe('tag:soup');
    expect(searchFilter('status', 'in progress')).toBe('status:"in progress"');
    expect(searchFilter('cook time', '40')).toBe('cook_time:40');
    expect(searchFilter('note', 'say "hi" \\ bye')).toBe('note:"say \\"hi\\" \\\\ bye"');
    expect(searchFilter('a.b', 'x')).toBeNull();
    expect(searchFilter('tag', ' ')).toBeNull();
    expect(searchFilter('tags', '#')).toBeNull();
    // A name of digits alone would read as a time, so no filter has one.
    expect(searchFilter('2024', 'x')).toBeNull();
    expect(searchFilter('url', '//example.com')).toBe('url:"//example.com"');
    for (const [key, value] of [
      ['status', 'in progress'],
      ['note', 'say "hi" \\ bye'],
      ['tag', 'soup'],
    ] as const) {
      expect(parseSearch(searchFilter(key, value) ?? '').filters).toEqual([{ key, value }]);
    }
  });
});

describe('matching a filter', () => {
  const props = propertyData(
    [
      '---',
      'status: In Progress',
      'servings: 4',
      'tried: true',
      'cook_time: 40',
      'made: 2026-10-01',
      'cuisine: [Italian, "Crème"]',
      'goes_with: "[[Garlic bread]]"',
      'empty:',
      'tags: soup',
      '---',
      '',
    ].join('\n'),
  );
  const passes = (key: string, value: string) => matchesFilter(props, { key, value });

  it('finds a key as a reference does, and its value whatever its case', () => {
    expect(passes('status', 'in progress')).toBe(true);
    expect(passes('Cook time', '40')).toBe(true);
    expect(passes('cook-time', '40')).toBe(true);
    expect(passes('servings', '4')).toBe(true);
    expect(passes('servings', '4.0')).toBe(true);
    expect(passes('tried', 'TRUE')).toBe(true);
    expect(passes('made', '2026-10-01')).toBe(true);
    expect(passes('cuisine', 'italian')).toBe(true);
    expect(passes('cuisine', 'creme')).toBe(true);
    expect(passes('goes_with', 'garlic bread')).toBe(true);
    expect(passes('goes_with', '[[Garlic bread]]')).toBe(true);
    expect(passes('tag', 'Soup')).toBe(true);
  });

  it('matches whole values only', () => {
    expect(passes('status', 'progress')).toBe(false);
    expect(passes('servings', '44')).toBe(false);
    expect(passes('servings', 'four')).toBe(false);
    expect(passes('cuisine', 'Italian, Crème')).toBe(false);
    expect(passes('empty', 'null')).toBe(false);
    expect(passes('missing', 'x')).toBe(false);
    expect(passes('tag', 'italian')).toBe(false);
    // An empty filter passes nothing, not even an empty text.
    const empty = propertyData('---\nstatus: ""\n---\n');
    expect(matchesFilter(empty, { key: 'status', value: '' })).toBe(false);
    expect(passes('status', ' ')).toBe(false);
  });
});

describe('a search with filters', () => {
  const index = indexOf({
    'Bean soup': '---\ntags: [soup, winter]\nstatus: tried\n---\nBeans and stock.',
    'Pea soup': '---\ntags: soup\nstatus: in progress\n---\nPeas, mint, stock.',
    Bread: '---\ntags: [bread]\n---\nFlour and stock of yeast.',
    'Soup notes': 'Soup without tags.',
  });

  it('finds pages passing every filter, alone or with words, by title when alone', () => {
    expect(found(index, 'tag:soup')).toEqual(['Bean soup', 'Pea soup']);
    expect(found(index, 'tag:SOUP tag:winter')).toEqual(['Bean soup']);
    expect(found(index, 'status:"in progress"')).toEqual(['Pea soup']);
    expect(found(index, 'mint tag:soup')).toEqual(['Pea soup']);
    expect(found(index, 'stock tag:soup')).toEqual(['Bean soup', 'Pea soup']);
    expect(found(index, 'stock tag:bread')).toEqual(['Bread']);
    expect(found(index, 'flour tag:soup')).toEqual([]);
    expect(found(index, 'tag:nothing')).toEqual([]);
    // A half-typed filter is left out: the words still search.
    expect(found(index, 'soup tag:')).toEqual(['Bean soup', 'Pea soup', 'Soup notes']);
    expect(found(index, 'tag:')).toEqual([]);
  });

  it('marks the title by words only, and with filters alone the snippet by their values', () => {
    const [hit] = index.search('tag:winter');
    expect(hit?.score).toBe(0);
    expect(hit?.title.highlights).toEqual([]);
    const snippet = hit?.snippet();
    expect(snippet?.text).toContain('winter');
    const marked = snippet?.highlights.map(({ start, end }) => snippet.text.slice(start, end));
    expect(marked).toEqual(['winter']);
    const [worded] = index.search('mint tag:soup');
    expect(worded?.title.highlights).toEqual([]);
    expect(worded?.snippet().highlights).toHaveLength(1);
  });

  it('takes time linear in the pages it tries', () => {
    const pages = (n: number) =>
      indexOf(
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `Page ${i}`,
            `---\ntags: [t${i % 7}, soup]\nn: ${i}\n---\nText ${i}`,
          ]),
        ),
      );
    const [small, large] = [pages(500), pages(4000)];
    const run = (size: string) =>
      (size === 's' ? small : large).search('tag:soup n:3', { limit: 50 });
    // 8 times the pages; quadratic would be 64.
    expect(growth(run, 's', 'l')).toBeLessThan(24);
    // A filter is read once, not for each page, and the same one only once.
    const long = `n:${'é'.repeat(20_000)}`;
    expect(cpuTime(() => large.search(long)).ms).toBeLessThan(500);
    expect(cpuTime(() => large.search('tag:soup '.repeat(300))).ms).toBeLessThan(500);
    // Every page passes, so all are sorted by title: n log n.
    const all = (size: string) => (size === 's' ? small : large).search('tag:soup', { limit: 50 });
    expect(all('l')).toHaveLength(50);
    expect(growth(all, 's', 'l')).toBeLessThan(24);
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
