import { describe, expect, it } from 'vite-plus/test';
import {
  parsePageQuery,
  publicLinkOperations,
  runPageQuery,
  type PageQuery,
  type PropertyData,
  type QueryFolder,
  type QueryPage,
} from '../src/index.ts';
import { cpuTime, growth } from './support/timing.ts';

const parsed = (source: string): PageQuery => {
  const read = parsePageQuery(source);
  if (!read.ok) throw new Error(read.error);
  return read.query;
};
const error = (source: string) => {
  const read = parsePageQuery(source);
  return read.ok ? null : read.error;
};

describe('reading a query block', () => {
  it('reads the example in the issue', () => {
    expect(
      parsed(
        'from: Recipes\nwhere: tried = true, servings >= 2\nshow: servings, cook_time, last_made\nsort: last_made desc\n',
      ),
    ).toEqual({
      from: { folder: ['Recipes'] },
      where: [
        { name: 'tried', operator: '=', value: { kind: 'boolean', value: true } },
        { name: 'servings', operator: '>=', value: { kind: 'number', value: 2 } },
      ],
      show: ['servings', 'cook_time', 'last_made'],
      sort: { by: { name: 'last_made' }, descending: true },
      limit: 100,
    });
  });

  it('takes the whole space, no conditions and no columns by default', () => {
    expect(parsed('')).toEqual({ from: null, where: [], show: [], sort: null, limit: 100 });
    expect(parsed('\r\n  \r\n')).toEqual(parsed(''));
  });

  it('reads tags, paths, every operator, quoted and typed values, any case of line', () => {
    const query = parsed(
      [
        'FROM: #soup',
        'Where: status != "in progress, still", rating < 4.5, made <= 2026-10-12, made > 2026-10-12T09:30Z,',
        '  x >= -2, tags has Bread, note = plain words, cook time=25',
        'Sort: title',
        'LIMIT: 500',
      ]
        .join('\n')
        .replace(',\n  ', ', '),
    );
    expect(query.from).toEqual({ tag: 'soup' });
    expect(query.where.map(({ name, operator, value }) => [name, operator, value])).toEqual([
      ['status', '!=', { kind: 'text', value: 'in progress, still' }],
      ['rating', '<', { kind: 'number', value: 4.5 }],
      ['made', '<=', { kind: 'date', value: Date.UTC(2026, 9, 12) }],
      ['made', '>', { kind: 'date', value: Date.UTC(2026, 9, 12, 9, 30) }],
      ['x', '>=', { kind: 'number', value: -2 }],
      ['tags', 'has', { kind: 'text', value: 'Bread' }],
      ['note', '=', { kind: 'text', value: 'plain words' }],
      ['cook time', '=', { kind: 'number', value: 25 }],
    ]);
    expect(query.sort).toEqual({ by: 'title', descending: false });
    expect(query.limit).toBe(500);
    expect(parsed('from: Recipes / Soups').from).toEqual({ folder: ['Recipes', 'Soups'] });
    expect(parsed('from: "Old recipes"').from).toEqual({ folder: ['Old recipes'] });
    expect(parsed('sort: cook time asc').sort).toEqual({
      by: { name: 'cook time' },
      descending: false,
    });
  });

  it('reads a date the calendar hasn’t as text, and years before 100 as written', () => {
    for (const text of ['2024-13-45', '2024-02-30', '2026-10-12T24:00']) {
      expect(parsed(`where: due < ${text}`).where[0]?.value, text).toEqual({
        kind: 'text',
        value: text,
      });
    }
    const early = new Date(0);
    early.setUTCFullYear(50, 0, 2);
    expect(parsed('where: due = 0050-01-02').where[0]?.value).toEqual({
      kind: 'date',
      value: early.getTime(),
    });
  });

  it('says in one line what doesn’t read', () => {
    const cases: [string, RegExp][] = [
      ['from Recipes', /^Line 1 isn’t one of/],
      ['\n\nselect: x', /^Line 3 /],
      ['show: a\nshow: b', /twice/],
      ['from:', /folder’s path, or a #tag/],
      ['from: #', /one #tag/],
      ['from: #two tags', /one #tag/],
      ['from: a//b', /between slashes/],
      ['where: servings', /isn’t a condition/],
      ['where: = 4', /isn’t a condition/],
      ['where: servings =', /isn’t a condition/],
      ['where: SUM(a) = 4', /isn’t a condition/],
      ['where: a = "open', /quote in where/],
      ['where: a = b"c"', /isn’t a condition/],
      ['where: a = 1,', /isn’t a condition/],
      ['show: a, , b', /isn’t one/],
      ['show: =x', /isn’t one/],
      ['sort: ', /sort: takes/],
      ['sort: (x) desc', /sort: takes/],
      ['limit: 0', /1 to 500/],
      ['limit: 501', /1 to 500/],
      ['limit: 2.5', /1 to 500/],
      ['limit: ten', /1 to 500/],
    ];
    for (const [source, message] of cases) {
      const said = error(source);
      expect(said ?? 'read', source).toMatch(message);
      expect(said, source).not.toContain('\n');
    }
  });

  it('refuses a block too long, or with too many conditions or columns', () => {
    expect(error(`show: ${'a'.repeat(10_001)}`)).toMatch(/too long/);
    expect(error(`where: ${Array.from({ length: 51 }, (_, i) => `k${i} = 1`).join(', ')}`)).toMatch(
      /at most 50 conditions/,
    );
    expect(error(`show: ${Array.from({ length: 51 }, (_, i) => `k${i}`).join(', ')}`)).toMatch(
      /at most 50 columns/,
    );
  });

  it('reads hostile text in time linear in its length', () => {
    const hostile = [
      (n: number) => `where: ${'a '.repeat(n)}`,
      (n: number) => `where: a = ${'"'.repeat(n)}`,
      (n: number) => `sort: ${'x\t'.repeat(n)}desc`,
      (n: number) => `sort: x${' '.repeat(n)}`,
      (n: number) => `from: ${'a/'.repeat(n)}b`,
      (n: number) => `where: ${'a has '.repeat(n)}`,
      (n: number) => `where: a = 2026-10-12${'0'.repeat(n)}`,
      (n: number) => `${':'.repeat(n)}`,
      (n: number) => `where: a${'='.repeat(n)}`,
    ];
    for (const make of hostile) {
      const [small, large] = [make(400), make(3200)];
      const ratio = growth(
        (source) => {
          for (let i = 0; i < 20; i++) parsePageQuery(source);
        },
        small,
        large,
      );
      expect(ratio, small.slice(0, 20)).toBeLessThan(40);
      expect(cpuTime(() => parsePageQuery(make(4900))).ms).toBeLessThan(200);
    }
  });
});

type Page = QueryPage & { id: string };

const page = (
  id: string,
  title: string,
  properties: PropertyData[],
  folderIds: string[] = [],
): Page => ({ id, title, properties, folderIds });

const FOLDERS: QueryFolder[] = [
  { id: 'f-recipes', parentId: null, name: 'Recipes' },
  { id: 'f-soups', parentId: 'f-recipes', name: 'Soups' },
  { id: 'f-old', parentId: null, name: 'Old' },
  { id: 'f-old-soups', parentId: 'f-old', name: 'Soups' },
];

const PAGES: Page[] = [
  page(
    'bread',
    'Garlic bread',
    [
      { key: 'tried', type: 'boolean', value: true },
      { key: 'servings', type: 'number', value: 4 },
      { key: 'cook_time', type: 'number', value: 25 },
      { key: 'last_made', type: 'date', value: '2026-10-12' },
      { key: 'tags', type: 'list', value: ['bread', 'Sides'] },
      { key: 'status', type: 'text', value: 'Done' },
    ],
    ['f-recipes'],
  ),
  page(
    'soup',
    'Tomato soup',
    [
      { key: 'Tried', type: 'boolean', value: true },
      { key: 'servings', type: 'number', value: 6 },
      { key: 'cook-time', type: 'number', value: 60 },
      { key: 'last_made', type: 'date', value: '2026-09-01' },
      { key: 'tags', type: 'list', value: ['soup'] },
      { key: 'status', type: 'text', value: '35' },
    ],
    ['f-recipes', 'f-soups'],
  ),
  page(
    'tart',
    'Lemon tart',
    [
      { key: 'tried', type: 'boolean', value: false },
      { key: 'servings', type: 'text', value: '8' },
      { key: 'tags', type: 'text', value: 'dessert' },
    ],
    ['f-recipes'],
  ),
  page(
    'broth',
    'Old broth',
    [{ key: 'servings', type: 'number', value: 2 }],
    ['f-old', 'f-old-soups'],
  ),
  page('notes', 'Notes', []),
];

const run = (source: string, pages = PAGES) =>
  runPageQuery(parsed(source), { pages, folders: FOLDERS });
const titles = (source: string, pages = PAGES) => {
  const result = run(source, pages);
  if (!result.ok) throw new Error(result.error);
  return result.rows.map((row) => row.page.title);
};

describe('running a query', () => {
  it('lists the issue’s example, with each column’s value', () => {
    const result = run(
      'from: Recipes\nwhere: tried = true, servings >= 2\nshow: servings, cook_time, last_made\nsort: last_made desc',
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.rows.map((row) => row.page.title)).toEqual(['Garlic bread', 'Tomato soup']);
    expect(result.columns).toEqual(['servings', 'cook_time', 'last_made']);
    // Keys match as references' names do.
    expect(result.rows[1]?.values.map((value) => value?.value)).toEqual([6, 60, '2026-09-01']);
    expect(result.total).toBe(2);
  });

  it('takes a folder with those under it, by its path from the top or the folders ending it', () => {
    expect(titles('from: Recipes')).toEqual(['Garlic bread', 'Tomato soup', 'Lemon tart']);
    expect(titles('from: recipes/soups')).toEqual(['Tomato soup']);
    expect(titles('from: Old/Soups')).toEqual(['Old broth']);
    expect(run('from: Soups')).toEqual({
      ok: false,
      error: 'More than one folder is at Soups; give more of its path.',
    });
    expect(run('from: Desserts')).toEqual({ ok: false, error: 'No folder here is at Desserts.' });
  });

  it('takes a tag as tag search does, and the whole space by default', () => {
    expect(titles('from: #Soup')).toEqual(['Tomato soup']);
    expect(titles('from: #dessert')).toEqual(['Lemon tart']);
    expect(titles('')).toEqual(PAGES.map((p) => p.title));
  });

  it('compares numbers and dates as such, text only for equality, whatever its case', () => {
    expect(titles('where: servings > 4')).toEqual(['Tomato soup']);
    // Text "8" isn't a number.
    expect(titles('where: servings >= 8')).toEqual([]);
    expect(titles('where: servings = "8"')).toEqual(['Lemon tart']);
    expect(titles('where: last_made < 2026-10-01')).toEqual(['Tomato soup']);
    expect(titles('where: last_made >= 2026-10-12T00:00')).toEqual(['Garlic bread']);
    expect(titles('where: status = done')).toEqual(['Garlic bread']);
    expect(titles('where: status > a')).toEqual([]);
    expect(titles('where: status = 35')).toEqual([]);
    expect(titles('where: status = "35"')).toEqual(['Tomato soup']);
    expect(titles('where: tried = false')).toEqual(['Lemon tart']);
  });

  it('has a list hold a value, and != hold where = doesn’t, a missing value too', () => {
    expect(titles('where: tags has sides')).toEqual(['Garlic bread']);
    expect(titles('where: tags = SOUP')).toEqual(['Tomato soup']);
    expect(titles('where: tags has dessert')).toEqual(['Lemon tart']);
    expect(titles('where: tried != true')).toEqual(['Lemon tart', 'Old broth', 'Notes']);
    expect(titles('where: tags > a')).toEqual([]);
  });

  it('sorts, missing values last either way, then as given, and keeps to its limit', () => {
    expect(titles('sort: servings')).toEqual([
      'Old broth',
      'Garlic bread',
      'Tomato soup',
      'Lemon tart',
      'Notes',
    ]);
    expect(titles('sort: servings desc')).toEqual([
      'Lemon tart',
      'Tomato soup',
      'Garlic bread',
      'Old broth',
      'Notes',
    ]);
    expect(titles('sort: title desc\nlimit: 2')).toEqual(['Tomato soup', 'Old broth']);
    const limited = run('sort: title\nlimit: 2');
    expect(limited.ok && limited.total).toBe(5);
  });

  it('runs over many pages in time linear in them', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        page(
          `p${i}`,
          `Page ${i}`,
          [
            { key: 'n', type: 'number', value: i % 97 },
            { key: 'tags', type: 'list', value: ['a', 'b', `t${i % 7}`] },
          ],
          ['f-recipes'],
        ),
      );
    const query = parsed(
      'from: Recipes\nwhere: n > 10, tags has t3, n != 50\nshow: n, tags\nsort: n desc\nlimit: 500',
    );
    const [small, large] = [many(1000), many(8000)];
    const pages = new Map([
      ['small', small],
      ['large', large],
    ]);
    const ratio = growth(
      (which) => runPageQuery(query, { pages: pages.get(which) ?? [], folders: FOLDERS }),
      'small',
      'large',
    );
    // Sorting is n log n; 8× the pages within 20×.
    expect(ratio).toBeLessThan(20);
    expect(
      cpuTime(() => runPageQuery(query, { pages: many(20_000), folders: FOLDERS })).ms,
    ).toBeLessThan(1000);
  });
});

describe('a query table in a public copy', () => {
  const result = run('from: Recipes\nshow: servings, status, tags\nsort: title');
  if (!result.ok) throw new Error(result.error);
  const table = publicLinkOperations.queryTableMarkdown(
    result,
    (row) => row.title === 'Garlic bread',
  );

  it('is a GFM table, a public page as its wikilink, every other cell its text escaped', () => {
    expect(table).toEqual([
      '| Page | &#83;erving&#115; | &#83;tatu&#115; | &#84;ag&#115; |',
      '| --- | --- | --- | --- |',
      '| [[Garlic bread]] | &#52; | &#68;on&#101; | &#98;read\\, Side&#115; |',
      '| &#76;emon tar&#116; | &#56; |  | &#100;esser&#116; |',
      '| &#84;omato sou&#112; | &#54; | &#51;&#53; | &#115;ou&#112; |',
    ]);
  });

  it('keeps a hostile value in its cell, as only its text', () => {
    const hostile = publicLinkOperations.queryTableMarkdown(
      {
        columns: ['note'],
        rows: [
          {
            page: { title: '| x <b>' },
            values: [
              {
                key: 'note',
                type: 'text',
                value: 'a | b\n| c | d\n<img src=x onerror=alert(1)> [[p]]',
              },
            ],
          },
        ],
      },
      () => false,
    );
    const row = hostile[2] ?? '';
    // Only the row's own bars split it: every other is escaped.
    expect(row.split(/(?<!\\)\|/).length).toBe(4);
    expect(row).not.toContain('\n');
    expect(row).not.toMatch(/(?<!\\)</);
    expect(row).toContain('\\[\\[p\\]&#93;');
  });

  const lines = ['| Page |', '| --- |', '| x |'];
  const copy = (body: string) => publicLinkOperations.copyBody(body, undefined, () => lines);

  it('goes where its block was, with blank lines around it, inside lists and quotes too', () => {
    expect(copy('Intro\n```wikistow-query\nfrom: A\n```\nAfter\n')).toBe(
      'Intro\n\n| Page |\n| --- |\n| x |\n\nAfter\n',
    );
    expect(copy('```wikistow-query\n```\n\nAfter\n')).toBe('| Page |\n| --- |\n| x |\n\nAfter\n');
    expect(copy('- item\n\n  ```wikistow-query\n  from: A\n  ```\n')).toBe(
      '- item\n\n  | Page |\n  | --- |\n  | x |\n',
    );
    expect(copy('> ```wikistow-query\n> from: A\n> ```\n> after\n')).toBe(
      '> | Page |\n> | --- |\n> | x |\n>\n> after\n',
    );
  });

  it('stays in its list item after a line of text, its first row indented too', () => {
    expect(copy('- item text\n  ```wikistow-query\n  from: A\n  ```\n  more\n')).toBe(
      '- item text\n  \n  | Page |\n  | --- |\n  | x |\n\n  more\n',
    );
  });

  it('keeps a CRLF page’s line breaks, with the blank line after it', () => {
    expect(copy('Intro\r\n```wikistow-query\r\nfrom: A\r\n```\r\nAfter\r\n')).toBe(
      'Intro\r\n\r\n| Page |\r\n| --- |\r\n| x |\r\n\r\nAfter\r\n',
    );
  });

  it('leaves a block it has no table for, other code and Dataview’s as written', () => {
    const body = '```wikistow-query\nfrom: A\n```\n\n```dataview\nTABLE x\n```\n';
    expect(publicLinkOperations.copyBody(body)).toBe(body);
    expect(
      publicLinkOperations.copyBody(body, undefined, (source) =>
        source === 'from: B' ? lines : undefined,
      ),
    ).toBe(body);
  });

  it('says a copy lists other pages', () => {
    expect(publicLinkOperations.fromOtherPages('```wikistow-query\n```')).toEqual({
      values: false,
      lists: true,
    });
    expect(publicLinkOperations.fromOtherPages('```dataview\nTABLE x\n```')).toEqual({
      values: false,
      lists: false,
    });
  });
});
