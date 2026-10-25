import { splitFrontmatter } from './markdown/frontmatter.ts';
import {
  findProperty,
  foldPropertyName,
  propertyData,
  propertyWikilink,
  type PropertyData,
  type PropertyValue,
} from './markdown/properties.ts';

// Local full-text search over the pages a person can decrypt. Nothing here
// leaves memory: the index is built from opened pages, and from what an
// earlier index read from them (`pages`, `addText`).

/**
 * An in-memory inverted index of page titles and text, searched as you type.
 *
 * - **Text.** Markdown is reduced to readable text (`searchText`): syntax
 *   characters, link targets and definitions, fence lines, table delimiter
 *   rows and HTML tags go; shown link text, image alt text, code, the text
 *   in HTML and frontmatter stay, the last as plain text. Only the first
 *   `TEXT_LIMIT` characters of it are kept, read from lines cut at
 *   `LINE_LIMIT`, and paragraphs in pieces of at most that: whatever a page
 *   holds, indexing it takes bounded time.
 * - **Properties.** Beside its text, each page keeps its frontmatter's
 *   properties as plain data (`propertyData`), the block split off the
 *   page's Markdown, not read from its text. Reading a block is linear in
 *   its size, and one over 64 KiB, or that doesn't read as a map, gives
 *   none, so this is bounded too.
 * - **Terms** (`searchTerms`) are runs of letters and digits, folded: NFKD,
 *   combining marks dropped, recomposed (NFC, so Hangul stays whole),
 *   lower-cased, `ß` as `ss`. So `Café` matches
 *   `cafe`. Han, Hiragana and Katakana don't separate words, so each of their
 *   characters is a term of its own, and a query for `日本` finds pages with
 *   both characters.
 * - **Queries** are words and filters (`parseSearch`), and match pages
 *   holding every term of the words and passing every filter. The last term
 *   also matches as a prefix (`back` finds `backup`), the others only whole.
 *   A filter with no value ending the query, as one half typed (`tag:`,
 *   `tag:#`), is left out, and elsewhere is words (`Re: dinner`); a quote
 *   left open runs to the query's end; a word in quotes is always words, so
 *   `"10:30"` searches text, where `10:30` would be a filter.
 * - **Filters** match properties (`matchesFilter`): `tag:soup` or
 *   `tags:soup` a page tagged `soup` (`hasTag`, which reads Obsidian's
 *   older `tag` as tags too),
 *   `key:value` one whose `key` is `value` or a
 *   list holding it, `status:"in progress"` in quotes. A filter only
 *   narrows: it adds nothing to a page's score.
 * - **Ranking** sums, per query term, its rarity (`log(1 + pages / pages with
 *   it)`) times `TITLE_BOOST` if the title has it plus the text's saturated
 *   count (`n / (n + 1.2)`, under 1). A title match therefore beats any count
 *   in the text. A longer word matched by prefix counts `PREFIX_WEIGHT` as
 *   much. Equal scores sort by title, so filters alone list pages by title.
 * - **Snippets** are about `SNIPPET` characters of text around the window
 *   with the most distinct query terms among the first `SNIPPET_SCAN`, cut
 *   at spaces and marked `…` where cut; with no match there, its start. With
 *   filters alone, the terms of their values stand in, matched whole, so a
 *   snippet shows the frontmatter line a filter matched where it can. A
 *   hit builds its snippet when asked, so only the rows shown pay for one.
 *   Highlights are UTF-16 offsets into the snippet's (or title's) own text.
 *
 * Searching takes time linear in the query, in the postings of its terms,
 * and with filters, in the properties of the pages they're tried on, times
 * the number of different filters: the pages holding the words, or with
 * filters alone, every page. The last term also reads each indexed term it
 * starts, found in the terms sorted, which the first search after pages are
 * added sorts again. Then the pages found are sorted, in time `n log n` in
 * their number.
 *
 * Each page keeps its title, its reduced text, its properties, and one
 * posting of two small integers per distinct term: a few times the text's
 * size in memory, and the properties a few times their block's, which is
 * at most 64 KiB: up to some 16 times for a block of one-item lists, each
 * item an array of its own, much as a text of distinct words costs in
 * postings. That is fine for a family library of thousands of pages.
 */
export class SearchIndex<T> {
  readonly #pages: IndexedPage<T>[] = [];
  // Each term's pages, as flat pairs: the page, and its counts as `add` packs them.
  readonly #postings = new Map<string, number[]>();
  #sorted: string[] | null = null;

  get size(): number {
    return this.#pages.length;
  }

  /** Index a page's title and Markdown; `doc` is what its hits return. */
  add(doc: T, page: { title: string; markdown: string }): void {
    this.addText(doc, { title: page.title, ...indexedContent(page.markdown) });
  }

  /**
   * Index a page as another index read it (`pages`): its title, its text
   * already reduced, and its properties, none if left out.
   */
  addText(doc: T, { title, text, properties = [] }: IndexedText): void {
    const id = this.#pages.length;
    this.#pages.push({ doc, title, text, properties });
    // Each term's count in the text, doubled, plus one if the title has it.
    const counts = new Map<string, number>();
    eachTerm(title, (term) => counts.set(term, (counts.get(term) ?? 0) | 1));
    eachTerm(text, (term) => counts.set(term, (counts.get(term) ?? 0) + 2));
    for (const [term, packed] of counts) {
      let list = this.#postings.get(term);
      if (!list) this.#postings.set(term, (list = []));
      list.push(id, packed);
    }
    this.#sorted = null;
  }

  /** Each page indexed, in the order added, with its text as reduced for search and its properties. */
  pages(): readonly Readonly<IndexedPage<T>>[] {
    return this.#pages;
  }

  /**
   * The best `limit` pages holding every term of `query`'s words and passing
   * each of its filters (`parseSearch`), best first.
   */
  search(query: string, { limit = 50 }: { limit?: number } = {}): SearchHit<T>[] {
    const { words, filters } = parseSearch(query);
    const wanted = queryTerms(words);
    if (wanted.length === 0 && filters.length === 0) return [];
    let scores: Map<number, number> | null = null;
    // Pages whose text, not only title, holds some query term.
    const inTexts = new Set<number>();
    for (const [i, term] of wanted.entries()) {
      const found = new Map<number, number>();
      for (const [match, weight] of this.#expand(term, i === wanted.length - 1)) {
        const list = this.#postings.get(match) ?? [];
        const rarity = Math.log(1 + this.#pages.length / (list.length / 2));
        for (let k = 0; k < list.length; k += 2) {
          const id = list[k] ?? 0;
          const packed = list[k + 1] ?? 0;
          const inText = packed >>> 1;
          if (inText > 0) inTexts.add(id);
          const score =
            weight * rarity * ((packed & 1 ? TITLE_BOOST : 0) + inText / (inText + 1.2));
          // A page is scored on the best word a prefix matched in it.
          found.set(id, Math.max(found.get(id) ?? 0, score));
        }
      }
      const before: Map<number, number> | null = scores;
      scores = new Map();
      for (const [id, score] of found) {
        if (before === null) scores.set(id, score);
        else if (before.has(id)) scores.set(id, (before.get(id) ?? 0) + score);
      }
      if (scores.size === 0) return [];
    }
    const hits: { page: IndexedPage<T>; score: number; inText: boolean }[] = [];
    const tests = filterTests(filters);
    const passes = (page: IndexedPage<T>) => tests.every((test) => test(page.properties));
    if (scores === null) {
      for (const page of this.#pages) if (passes(page)) hits.push({ page, score: 0, inText: true });
    } else {
      for (const [id, score] of scores) {
        const page = this.#pages[id];
        if (page && passes(page)) hits.push({ page, score, inText: inTexts.has(id) });
      }
    }
    // With filters alone, the snippet looks for their values' terms, whole.
    const shown = wanted.length > 0 ? wanted : filterTerms(filters);
    const prefix = wanted.length > 0;
    return hits
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
      .slice(0, limit)
      .map(({ page, score, inText }) => {
        let snippet: Marked | undefined;
        return {
          doc: page.doc,
          score,
          title: { text: page.title, highlights: matchesIn(page.title, wanted) },
          // A title-only hit shows the text's start without looking through it.
          snippet: () => (snippet ??= snippetOf(page.text, inText ? shown : [], prefix)),
        };
      });
  }

  /** The indexed terms `term` stands for, each with its weight. */
  *#expand(term: string, prefix: boolean): Generator<[string, number]> {
    if (this.#postings.has(term)) yield [term, 1];
    if (!prefix) return;
    const sorted = (this.#sorted ??= [...this.#postings.keys()].sort());
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((sorted[mid] ?? '') <= term) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < sorted.length; i++) {
      const longer = sorted[i] ?? '';
      if (!longer.startsWith(term)) break;
      yield [longer, PREFIX_WEIGHT];
    }
  }
}

/** A page as an index holds it: what its hits return, its title, its reduced text and its properties. */
export type IndexedPage<T> = {
  doc: T;
  title: string;
  text: string;
  properties: readonly Readonly<PropertyData>[];
};

/** A page as `addText` takes it. */
export type IndexedText = {
  title: string;
  text: string;
  properties?: readonly Readonly<PropertyData>[];
};

/** What the index keeps of a page's Markdown: its text for search, and its properties. */
export function indexedContent(markdown: string): {
  text: string;
  properties: PropertyData[];
} {
  const properties = propertyData(splitFrontmatter(markdown).frontmatter);
  return {
    text: searchText(markdown),
    // Copied: a string cut from the page's Markdown can hold all of it in memory.
    properties:
      properties.length > 0 ? (JSON.parse(JSON.stringify(properties)) as PropertyData[]) : [],
  };
}

/**
 * Whether `properties` are tagged `tag`: their `tags`, or Obsidian's older
 * `tag` (named as a reference names it, `findProperty`), is a list holding
 * it, or is it. Tags
 * compare as search terms do, whatever their accents and case, and without
 * a `#` before them, so `#Soup` is `soup`.
 */
export function hasTag(properties: readonly Readonly<PropertyData>[], tag: string): boolean {
  return tagged(properties, tagName(tag));
}

/** Whether `properties` hold the tag `wanted`, already a `tagName`. */
function tagged(properties: readonly Readonly<PropertyData>[], wanted: string): boolean {
  const matches = (value: string | number | boolean) => tagName(String(value)) === wanted;
  return (
    wanted !== '' &&
    (holds(findProperty(properties, 'tags')?.value, matches) ||
      holds(findProperty(properties, 'tag')?.value, matches))
  );
}

const tagName = (tag: string) => foldTerm(tag.trim().replace(/^#/, ''));

/**
 * Whether a property's value is a scalar `matches` takes, or a list holding
 * one, in a list of its own too. Empty values match nothing.
 */
function holds(
  value: PropertyValue | undefined,
  matches: (scalar: string | number | boolean) => boolean,
): boolean {
  const items = isList(value) ? value.flatMap((item) => (isList(item) ? item : [item])) : [value];
  return items.some((item) => item !== null && item !== undefined && matches(item));
}

// `Array.isArray` doesn't narrow a readonly array.
const isList = <T>(value: T | readonly T[]): value is readonly T[] => Array.isArray(value);

/**
 * A filter in a query (`parseSearch`): `tag:soup` as `{ key: 'tag', value:
 * 'soup' }`, `status:"in progress"` as `{ key: 'status', value: 'in
 * progress' }`.
 */
export type SearchFilter = { key: string; value: string };

/**
 * A query's words and filters. A filter is a word starting with a name, as
 * a property reference's (letters, digits, `_` and `-`; for a key with
 * spaces, `_` stands in, as `cook_time` finds `cook time`), then `:` and its
 * value: what follows up to a space, or in double quotes, which allow
 * spaces, with `\"` and `\\` for a quote and a backslash in them (any
 * other backslash is itself). A quote
 * not closed runs to the query's end. Everything else is words, a word in
 * quotes too, so `"10:30"` or `"https://example.com"` searches text. A
 * filter with no value (`tag:`, `tag:#`, `status:""`) ending the query, as
 * one half typed, is left out; elsewhere it is words (`Re: dinner`). Linear in the query's length.
 */
export function parseSearch(query: string): { words: string; filters: SearchFilter[] } {
  const words: string[] = [];
  const filters: SearchFilter[] = [];
  let at = 0;
  while (at < query.length) {
    if (/\s/u.test(query.charAt(at))) {
      at++;
      continue;
    }
    FILTER_NAME.lastIndex = at;
    const name = FILTER_NAME.exec(query)?.[1];
    if (name !== undefined) {
      const quoted = readQuoted(query, at + name.length + 1);
      const end = quoted?.end ?? wordEnd(query, at + name.length + 1);
      const value = quoted?.text ?? query.slice(at + name.length + 1, end);
      if (!emptyFilter(name, value)) filters.push({ key: name, value });
      // One with nothing after it but more query is words (`Re: dinner`).
      else if (query.slice(end).trim() !== '') words.push(query.slice(at, end));
      at = end;
      continue;
    }
    const end = readQuoted(query, at)?.end ?? wordEnd(query, at);
    words.push(query.slice(at, end));
    at = end;
  }
  return { words: words.join(' '), filters };
}

/** A filter's name and its colon, at a word's start. */
const FILTER_NAME = /([\p{L}\p{N}][\p{L}\p{N}_-]*):/uy;

/** Where the word from `at` ends: the next space, or the query's end. */
function wordEnd(query: string, at: number): number {
  let end = at;
  while (end < query.length && !/\s/u.test(query.charAt(end))) end++;
  return end;
}

/** The text in double quotes from `at`, unescaped, and where it ends, or null if none starts there. */
function readQuoted(query: string, at: number): { text: string; end: number } | null {
  if (query.charAt(at) !== '"') return null;
  let text = '';
  for (let end = at + 1; end < query.length; end++) {
    const char = query.charAt(end);
    if (char === '"') return { text, end: end + 1 };
    const next = query.charAt(end + 1);
    if (char === '\\' && (next === '"' || next === '\\')) text += query.charAt(++end);
    else text += char;
  }
  return { text, end: query.length };
}

/**
 * A filter's text, for a query or a link to search (`parseSearch`):
 * `tag:soup`, or `status:"in progress"` when the value needs quotes. A
 * key's spaces become `_`, which finds it all the same. Null for a key no
 * filter can name, or an empty value (for a tag, nothing past a `#`).
 */
export function searchFilter(key: string, value: string): string | null {
  const name = key.trim().replace(/ /g, '_');
  if (!new RegExp(`^${FILTER_NAME.source}$`, 'u').test(`${name}:`) || emptyFilter(name, value)) {
    return null;
  }
  const plain = /^[^\s"\\]+$/u.test(value);
  return `${name}:${plain ? value : `"${value.replace(/[\\"]/g, '\\$&')}"`}`;
}

/**
 * Whether `properties` pass a filter. `tag` and `tags` ask for a tag (`hasTag`).
 * Another key is found as a reference finds it (`findProperty`), and passes
 * when its value, or an item of its list, is the filter's: a number as a
 * number (`4` is `4.0`), anything else as text, whatever its accents and
 * case (`foldTerm`), a wikilink as written or as its page's name
 * (`goes_with:"Garlic bread"` is `[[Garlic bread]]`). Empty values, the
 * filter's or the property's, never pass.
 */
export function matchesFilter(
  properties: readonly Readonly<PropertyData>[],
  filter: SearchFilter,
): boolean {
  return filterTest(filter)(properties);
}

/** `matchesFilter` for one filter, its value read once, to try on many pages. */
function filterTest({
  key,
  value,
}: SearchFilter): (properties: readonly Readonly<PropertyData>[]) => boolean {
  const trimmed = value.trim();
  if (trimmed === '') return () => false;
  const name = foldPropertyName(key);
  if (isTagKey(key)) {
    const tag = tagName(trimmed);
    return (properties) => tagged(properties, tag);
  }
  const wanted = foldTerm(trimmed);
  const number = NUMBER.test(trimmed) ? Number(trimmed) : null;
  const matches = (scalar: string | number | boolean) => {
    if (typeof scalar === 'number') return scalar === number;
    if (foldTerm(String(scalar).trim()) === wanted) return true;
    const link = propertyWikilink(scalar);
    return link !== null && foldTerm(link.target.trim()) === wanted;
  };
  // The first key a reference would take, as `findProperty` finds it.
  return (properties) =>
    holds(properties.find((property) => foldPropertyName(property.key) === name)?.value, matches);
}

/** Whether a filter has no value: none, or for a tag, none past its `#`. */
const emptyFilter = (key: string, value: string) =>
  isTagKey(key) ? tagName(value) === '' : value.trim() === '';

/** Whether a filter's key asks for a tag: `tag`, or `tags`, the key tags are in. */
const isTagKey = (key: string) => /^tags?$/.test(foldPropertyName(key));

/** Each of `filters` once, ready to try on pages. */
function filterTests(filters: readonly SearchFilter[]) {
  const unique = new Map<string, SearchFilter>();
  for (const filter of filters) {
    unique.set(`${foldPropertyName(filter.key)}\n${filter.value.trim()}`, filter);
  }
  return [...unique.values()].map(filterTest);
}

/** A number as YAML writes one, in decimal. */
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** The terms of filters' values, each once, for snippets. */
function filterTerms(filters: readonly SearchFilter[]): string[] {
  return [...new Set(filters.flatMap(({ value }) => searchTerms(value).map(({ term }) => term)))];
}

/** Text with the parts a query matched, as UTF-16 offsets into `text`. */
export type Marked = { text: string; highlights: { start: number; end: number }[] };

/** A page found; `snippet` is built on the first call. */
export type SearchHit<T> = { doc: T; score: number; title: Marked; snippet: () => Marked };

const TITLE_BOOST = 2;
const PREFIX_WEIGHT = 0.6;
const SNIPPET = 160;
/** Text kept before the first match in a snippet. */
const LEAD = 40;
/** Text looked through for a snippet: a match further into a long page shows its start. */
const SNIPPET_SCAN = 16 * 1024;
/** Search text kept per page, and Markdown read per line or paragraph piece (UTF-16 units). */
const TEXT_LIMIT = 64 * 1024;
const LINE_LIMIT = 16 * 1024;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** A word with CJK in it: each CJK character, and each run of anything else. */
const CJK_PARTS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const ASCII = /^\p{ASCII}*$/u;

/** A word as the index compares it: no accents or case. */
export const foldTerm = (word: string): string =>
  ASCII.test(word)
    ? word.toLowerCase()
    : word
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .normalize('NFC')
        .toLowerCase()
        .replaceAll('ß', 'ss');

/** Call `each` with every term in `text` and where its word is, in UTF-16 offsets. */
function eachTerm(text: string, each: (term: string, start: number, end: number) => void): void {
  for (const match of text.matchAll(WORD)) {
    const [word] = match;
    if (!CJK.test(word)) {
      const term = foldTerm(word);
      if (term) each(term, match.index, match.index + word.length);
      continue;
    }
    for (const part of word.matchAll(CJK_PARTS)) {
      const term = foldTerm(part[0]);
      const start = match.index + part.index;
      if (term) each(term, start, start + part[0].length);
    }
  }
}

/** Each term in `text` with where its word is, in UTF-16 offsets. */
export function searchTerms(text: string): { term: string; start: number; end: number }[] {
  const terms: { term: string; start: number; end: number }[] = [];
  eachTerm(text, (term, start, end) => terms.push({ term, start, end }));
  return terms;
}

/** A query's terms in order, each once; the last is the one matched as a prefix. */
function queryTerms(query: string): string[] {
  const terms = [...searchTerms(query)].map(({ term }) => term);
  const last = terms.at(-1);
  if (last === undefined) return [];
  return [...new Set(terms.slice(0, -1).filter((term) => term !== last)), last];
}

/** Which query term a word matches, or -1; with `prefix`, the last also as a prefix. */
function termIndex(term: string, wanted: readonly string[], prefix = true): number {
  const last = wanted.length - 1;
  const start = wanted[last];
  return prefix && start !== undefined && term.startsWith(start) ? last : wanted.indexOf(term);
}

function matchesIn(text: string, wanted: readonly string[]): Marked['highlights'] {
  const found: Marked['highlights'] = [];
  for (const { term, start, end } of searchTerms(text)) {
    if (termIndex(term, wanted) >= 0) found.push({ start, end });
  }
  return found;
}

function snippetOf(text: string, wanted: readonly string[], prefix = true): Marked {
  const matches: { start: number; end: number; term: number }[] = [];
  if (wanted.length > 0) {
    eachTerm(clip(text, SNIPPET_SCAN), (term, start, end) => {
      const index = termIndex(term, wanted, prefix);
      if (index >= 0) matches.push({ start, end, term: index });
    });
  }
  // Slide a window over the matches: those from `i` up to `j` fit beside the
  // `i`th, with `counts` of each query term's among them.
  const counts = wanted.map(() => 0);
  let distinct = 0;
  let best = { at: 0, distinct: 0, count: 0 };
  let j = 0;
  const add = (term: number, by: number) => {
    const count = (counts[term] ?? 0) + by;
    counts[term] = count;
    if (count === (by > 0 ? 1 : 0)) distinct += by;
  };
  for (const [i, first] of matches.entries()) {
    for (j = Math.max(j, i); j < matches.length; j++) {
      const next = matches[j];
      if (!next || next.end > first.start + SNIPPET - LEAD) break;
      add(next.term, 1);
    }
    if (distinct > best.distinct || (distinct === best.distinct && j - i > best.count)) {
      best = { at: first.start, distinct, count: j - i };
    }
    if (j > i) add(first.term, -1);
  }
  // Cut at spaces, not inside words.
  let start = Math.max(0, best.at - LEAD);
  if (start > 0 && /\S/.test(text.charAt(start - 1))) {
    const space = text.slice(start, best.at).search(/\s/);
    if (space >= 0) start += space + 1;
  }
  let end = Math.min(text.length, start + SNIPPET);
  if (end < text.length && /\S/.test(text.charAt(end))) {
    const space = text.slice(best.at, end).search(/\s\S*$/);
    if (space > 0) end = best.at + space;
  }
  [start, end] = [codePointStart(text, start), codePointStart(text, end)];
  const before = start > 0 ? '…' : '';
  const after = end < text.length ? '…' : '';
  return {
    text: before + text.slice(start, end).replaceAll('\n', ' ') + after,
    highlights: matches
      .filter((m) => m.start >= start && m.end <= end)
      .map((m) => ({ start: m.start - start + before.length, end: m.end - start + before.length })),
  };
}

/** `at`, moved back off the second half of a surrogate pair. */
const codePointStart = (text: string, at: number) =>
  at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(at)) ? at - 1 : at;

/** `text` up to `length`, not splitting a character. */
const clip = (text: string, length: number) =>
  text.length <= length ? text : text.slice(0, codePointStart(text, length));

/**
 * Markdown as readable text, one line per paragraph, for search: code stays
 * as written (fence lines go), HTML blocks as the reader shows them
 * (`HtmlReading`), frontmatter as plain text; headings, quotes, list
 * markers, link definitions and a table's delimiter row go, links and
 * wikilinks keep the text they show, images and embeds their alt text or
 * name, references to footnotes the page defines nothing, and other HTML
 * tags and emphasis go.
 *
 * Blocks are read a line at a time, inline syntax a paragraph at a time, so
 * a link or code span may wrap, as CommonMark has it. A paragraph ends, in
 * a quote or list item too, at a blank line, a line left out, a rule or
 * setext underline, a heading (a paragraph of its own), a line going deeper
 * in quotes, or the start of a fence, list item (one numbered past 1 only
 * on a line out of the paragraph's quotes or list items), footnote
 * definition or HTML block; other lines carry it on, lazily if they leave
 * quotes or list items. Link definitions are the lines a paragraph starts
 * with that make them up. A list item or footnote definition holds the
 * lines indented as far as its text (a footnote's, 4), so its later
 * paragraphs aren't code, and a line may open several, and quotes in them:
 * `1. - > a`. A table's header and rows and the lines of code stand alone,
 * and so does each line of an HTML block, up to its end, or the end of a
 * quote or list item it's in, as a fence's do.
 *
 * At most `limit` characters, from lines cut at `lineLimit` and paragraphs
 * read in pieces of at most `lineLimit`. Each pattern here runs in time
 * linear in what it reads (none can start again inside what it already
 * matched), as do the scanners for links and tags, and the limits bound
 * what is read even so.
 */
export function searchText(
  markdown: string,
  { limit = TEXT_LIMIT, lineLimit = LINE_LIMIT }: { limit?: number; lineLimit?: number } = {},
): string {
  // The footnotes the page defines: a reference to any other is text.
  const notes = new Set<string>();
  for (const [, label = ''] of markdown.matchAll(FOOTNOTE_DEFINITION)) notes.add(noteLabel(label));
  const kept: string[] = [];
  let length = 0;
  // A fence being read: the run that closes it, and the quotes and list
  // items it's in, which it ends with.
  let fence: { run: string; quoted: number; items: number } | null = null;
  // The paragraph being read, its length, its quote depth (or in a table, its
  // rows' depth) and how many list items and footnote definitions it's in.
  let paragraph: string[] = [];
  let size = 0;
  let depth = 0;
  let nested = 0;
  let table = false;
  // How many of the paragraph's first lines are link definitions, and what
  // the last of them waits for, or null once the paragraph is text.
  let defined = 0;
  let waiting: Waiting | null = null;
  // The list items and footnote definitions the last line was in, outermost
  // first, and whether it opened the last of them with nothing in it.
  const items: Item[] = [];
  let empty = false;
  // An HTML block being read: what ends it (`rawHtmlEnd`, or '' for a blank
  // line), how its lines read, and the quotes and list items it's in, which
  // it ends with.
  let html: { end: string; read: HtmlReading; quoted: number; items: number } | null = null;
  const keep = (text: string) => {
    if (!text) return;
    kept.push(text);
    length += text.length + 1;
  };
  const end = () => {
    keep(inline(paragraph.slice(defined).join('\n'), notes));
    paragraph = [];
    size = 0;
    defined = 0;
  };
  // The lines of the HTML block being read, read together, as a tag may
  // span lines, in pieces of at most `lineLimit`.
  let held: string[] = [];
  let heldSize = 0;
  const release = (read: HtmlReading) => {
    keep(read(held.join('\n')).trim());
    held = [];
    heldSize = 0;
  };
  const hold = (line: string, read: HtmlReading) => {
    if (heldSize + line.length > lineLimit) release(read);
    held.push(line);
    heldSize += line.length + 1;
  };
  for (const whole of markdown.split(/\r\n?|\n/)) {
    if (length >= limit) break;
    const line = clip(whole, lineLimit);
    // Block syntax is looked for past every quote marker, indent and list
    // marker, so a block in a quote or list item ends a paragraph too.
    const markers = /^(?:\s*>)*/.exec(line)?.[0] ?? '';
    const quoted = markers.replace(/[^>]/g, '').length;
    const quoteless = line.slice(markers.length);
    const blank = !quoteless.trim();
    const within = itemsIn(items, line, quoted, blank);
    const { base, indent, from } = within;
    // A list item opened empty ends at a blank line straight after it.
    const matched: number =
      blank && empty ? Math.min(within.matched, items.length - 1) : within.matched;
    empty = false;
    if (fence !== null) {
      if (quoted >= fence.quoted && matched >= fence.items) {
        // Closed by a run at least as long with nothing after it, in its own
        // quotes: one quoted deeper is code.
        const close = quoted === fence.quoted ? /^\s*(`{3,}|~{3,})\s*$/.exec(quoteless) : null;
        if (close?.[1]?.startsWith(fence.run)) fence = null;
        else keep(quoteless.trim());
        continue;
      }
      fence = null;
    }
    if (html !== null) {
      // More quote markers are the block's text, fewer end it, and so does a
      // blank line if it's what ends the block.
      const ends = blank && html.end === '' && quoted === html.quoted;
      if (!ends && quoted >= html.quoted && matched >= html.items) {
        hold(quoteless, html.read);
        if (html.end && quoteless.toLowerCase().includes(html.end)) {
          release(html.read);
          html = null;
        }
        continue;
      }
      release(html.read);
      html = null;
    }
    // Whether the line carries on the paragraph, if it's text: lazily, it may
    // leave quotes, but not enter them. (This and some consts below are typed
    // because TypeScript's narrowing in this loop would go round in a circle.)
    const open: boolean = paragraph.length > 0 && quoted <= depth;
    // Indented 4 or more past where its blocks start: code, or text carrying
    // on the paragraph, but no other block.
    const deep = !blank && indent - base >= 4;
    // Rules, frontmatter fences and setext underlines.
    const breaks = BREAK.test(line);
    // Whether list items the line opens break into the paragraph, so each
    // must be `INTERRUPTING`: as the reader has it, they do on a line in all
    // the paragraph's quotes and list items, even one opening a quote of its
    // own (`a\n> 2. b`). A line out of any, as one starting a sibling item
    // (`- a\n- 2. b`), opens what it likes.
    const interrupting: boolean = paragraph.length > 0 && quoted >= depth && matched >= nested;
    const listed: boolean =
      !deep &&
      !breaks &&
      ITEM_MARKER.test(quoteless) &&
      (!interrupting || INTERRUPTING.test(quoteless));
    const footnote: boolean = !deep && !listed && FOOTNOTE.test(quoteless.trimStart());
    // What the line opens, and what follows: no block starts at a list
    // item's task box.
    const opens: Opened | null =
      listed || footnote ? openers(quoteless, from, base, quoted, interrupting) : null;
    const content: string = opens?.content ?? quoteless.trimStart();
    const inner: number = quoted + (opens?.quotes ?? 0);
    const text = withoutClosingHashes(
      (listed ? content.replace(/^\[[ xX]\]\s+/, '') : content).replace(/^#{1,6}\s+/, ''),
    );
    // Whether the line carried on the paragraph, so stays in the list items
    // it's lazily left of.
    let carried = false;
    // A fence or HTML block the line starts, if it goes on past the line.
    let run: string | undefined;
    let opened: HtmlBlock | null = null;
    read: {
      if (breaks) {
        end();
        table = false;
        break read;
      }
      if (
        !deep &&
        (table || paragraph.length > defined) &&
        content.includes('|') &&
        DELIMITER_ROW.test(content)
      ) {
        // The line before was the table's header.
        const header = paragraph.pop();
        end();
        keep(inline(header ?? '', notes));
        table = true;
        depth = quoted;
        break read;
      }
      // Indented code, alone or after what the line opens, stands as
      // written; a fence's opening line, a rule or a setext underline shows
      // nothing.
      const code = (!open && deep) || opens?.code === true;
      run = deep || code ? undefined : /^(`{3,}(?![^`]*`)|~{3,})/.exec(content)?.[1];
      if (
        code ||
        run !== undefined ||
        (!deep && /^(?:(?:-\s*)+|=+\s*|([*_])\s*(?:\1\s*){2,})$/.test(content))
      ) {
        end();
        table = false;
        if (code) keep(content.trim());
        break read;
      }
      // A new list item, footnote or quote has no paragraph in it yet.
      const block: HtmlBlock | null = deep ? null : htmlBlock(content, open && opens === null);
      if (block !== null) {
        end();
        table = false;
        hold(content, block.read);
        if (block.closed) release(block.read);
        else opened = block;
        break read;
      }
      const heading = !deep && /^#{1,6}(?:\s|$)/.test(content);
      const starts = heading || opens !== null;
      if (!text.trim()) {
        end();
        table = false;
      } else if (table && !starts && quoted === depth) {
        keep(inline(text, notes));
      } else {
        table = false;
        carried = open && !starts;
        if (!carried || size + text.length > lineLimit) end();
        if (paragraph.length === 0) {
          depth = inner;
          nested = matched + (opens?.items.length ?? 0);
          waiting = 'label';
        }
        if (waiting !== null) waiting = heading ? null : defining(content, waiting);
        paragraph.push(text);
        size += text.length + 1;
        if (waiting === 'label' || waiting === 'title') defined = paragraph.length;
        if (heading) end();
      }
    }
    if (!carried) {
      items.length = matched;
      for (const item of opens?.items ?? []) items.push(item);
      empty = listed && !content.trim();
    }
    if (run !== undefined) fence = { run, quoted: inner, items: items.length };
    if (opened !== null) html = { ...opened, quoted: inner, items: items.length };
  }
  if (html !== null) release(html.read);
  end();
  return clip(kept.join('\n'), limit);
}

/** A line of a rule or setext underline. */
const BREAK = /^ {0,3}(?:([-*_])\s*(?:\1\s*){2,}|=+\s*|--+\s*)$/;

/** A list item's marker. */
const ITEM_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/;
/** A list item that can break into a paragraph: not empty, and not an ordered list from past 1. */
const INTERRUPTING = /^\s*(?:[-*+]|0{0,8}1[.)])\s+\S/;

/** A footnote definition's label. */
const FOOTNOTE = /^\[\^[^\][\s]+\]:/;
/** A footnote's label as Markdown matches it, by full case folding (`ß` as `SS`). */
const noteLabel = (label: string) => label.toLowerCase().toUpperCase();

/** A footnote definition's label, past any indent and quote and list markers. */
const FOOTNOTE_DEFINITION = /^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*\[\^([^\][\s]+)\]:/gm;

/**
 * A list item or footnote definition: how many columns its text is indented
 * from where the text of the quote or item it's in starts, and how many
 * quotes it's in.
 */
type Item = { indent: number; quoted: number };

/**
 * How many of `items`, outermost first, `line` is in, and columns of it:
 * where its blocks start (`base`), past the innermost of them in as many
 * quotes as it has or else its last quote marker and the space that may
 * take; where its own text starts (`indent`); and just past its last quote
 * marker (`from`). Columns count from the line's start, a tab to the next of
 * every 4. A blank line is in each item in no more quotes. Each item a line
 * is in takes a column of its indent, so this reads no more items than the
 * line has characters, besides those a blank line ends.
 */
function itemsIn(items: readonly Item[], line: string, quoted: number, blank: boolean) {
  // Past each quote marker: where the quote's text starts, and the column of
  // what comes first, the next marker or the line's text.
  const starts = [0];
  const firsts: number[] = [];
  let column = 0;
  for (let at = 0; at < line.length; at++) {
    const char = line.charAt(at);
    if (char === '\t') column += 4 - (column % 4);
    else if (char === '>' && starts.length <= quoted) {
      firsts.push(column++);
      starts.push(/[ \t]/.test(line.charAt(at + 1)) ? column + 1 : column);
    } else if (/\s/.test(char)) column++;
    else break;
  }
  firsts.push(column);
  const from = quoted > 0 ? (firsts[quoted - 1] ?? 0) + 1 : 0;
  let matched = items.length;
  if (blank) {
    while (matched > 0 && (items[matched - 1]?.quoted ?? 0) > quoted) matched--;
    return { matched, base: 0, indent: 0, from };
  }
  let base = starts[quoted] ?? 0;
  let start = 0;
  let level = -1;
  matched = 0;
  for (const item of items) {
    if (item.quoted > quoted) break;
    if (item.quoted !== level) [level, start] = [item.quoted, starts[item.quoted] ?? 0];
    if ((firsts[level] ?? 0) - start < item.indent) break;
    matched++;
    start += item.indent;
    if (level === quoted) base = start;
  }
  return { matched, base, indent: firsts[quoted] ?? 0, from };
}

/** The column the whitespace `text` starts with reaches, from `column`, a tab to the next of every 4. */
function columnAfter(text: string, column = 0): number {
  let at = column;
  for (const char of text) {
    if (char === ' ') at++;
    else if (char === '\t') at += 4 - (at % 4);
    else break;
  }
  return at;
}

/**
 * What a line opens, from `rest`, the line past its quote markers at column
 * `from`, starting with a list marker or footnote label: that list item or
 * footnote definition, indented from `base`, and each list item, footnote
 * definition and quote straight after it, in the one before; how many
 * quotes; and what follows them all, and whether it's indented code. Where
 * they'd break into a paragraph (`interrupting`), each list item must be
 * `INTERRUPTING`.
 */
function openers(
  rest: string,
  from: number,
  base: number,
  quoted: number,
  interrupting: boolean,
): Opened {
  const items: Item[] = [];
  let quotes = 0;
  // Where the text of what the next opens in starts, and the column `rest` is at.
  let start = base;
  let column = from;
  for (;;) {
    const text = rest.trimStart();
    const at = columnAfter(rest, column);
    if (text.startsWith('>')) {
      quotes++;
      column = at + 1;
      start = /[ \t]/.test(text.charAt(1)) ? column + 1 : column;
      rest = text.slice(1);
      // Indented 4 past where the quote's text starts, the text is code.
      if (columnAfter(rest, column) - start >= 4 && /\S/.test(rest)) {
        return { items, quotes, content: rest.trimStart(), code: true };
      }
      continue;
    }
    const label = FOOTNOTE.exec(text)?.[0];
    if (label !== undefined) {
      items.push({ indent: 4, quoted: quoted + quotes });
      start += 4;
      column = start;
      rest = text.slice(label.length).trimStart();
      continue;
    }
    // A rule straight after the first marker is in its item. (Further in,
    // one reads as empty items, with no text either way.)
    const rule = items.length === 1 && /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(text);
    const marker =
      rule || (interrupting && !INTERRUPTING.test(text))
        ? undefined
        : /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/.exec(text)?.[0];
    if (marker === undefined) return { items, quotes, content: text, code: false };
    const after = at + marker.length;
    rest = text.slice(marker.length);
    const spaced = columnAfter(rest, after);
    // Past 4 spaces, the text is indented code, and its column 1 past the marker.
    const code = spaced - after > 4;
    const textColumn = code || !/\S/.test(rest) ? after + 1 : spaced;
    items.push({ indent: textColumn - start, quoted: quoted + quotes });
    start = textColumn;
    column = after;
    if (code) return { items, quotes, content: rest.trimStart(), code };
  }
}

/** What a line opens (`openers`). */
type Opened = { items: Item[]; quotes: number; content: string; code: boolean };

/**
 * What the link definitions a paragraph starts with wait for: another
 * (`label`), a URL after a bare label, a title or another (`title`), or the
 * mark closing an open title.
 */
type Waiting = 'label' | 'url' | 'title' | '"' | "'" | ')';
const TITLE_CLOSES: Record<string, Waiting> = { '"': '"', "'": "'", '(': ')' };

/**
 * What a paragraph's link definitions wait for after `line`, the next of
 * them, given what they waited for, or null if it isn't one: a label, a URL
 * on its line or the next, and a title on the URL's line or the next, which
 * may go on over lines.
 */
function defining(line: string, waiting: Waiting): Waiting | null {
  let rest = line.trim();
  if (waiting.length === 1) return titleEnd(rest, waiting);
  if (waiting === 'title') {
    const close = TITLE_CLOSES[rest.charAt(0)];
    const title = close === undefined ? null : titleEnd(rest.slice(1), close);
    if (title !== null) return title;
  }
  if (waiting !== 'url') {
    const label = /^\[(?!\^[^\][\s]+\]:)[^\]]+\]:/.exec(rest)?.[0];
    if (label === undefined) return null;
    rest = rest.slice(label.length).trimStart();
    if (!rest) return 'url';
  }
  const url = /^(?:<[^>]*>|[^\s<]\S*)/.exec(rest)?.[0];
  if (url === undefined) return null;
  rest = rest.slice(url.length);
  if (!rest) return 'title';
  const close = /^\s/.test(rest) ? TITLE_CLOSES[rest.trimStart().charAt(0)] : undefined;
  return close === undefined ? null : titleEnd(rest.trimStart().slice(1), close);
}

/**
 * Where an open title, closed by `close`, is after `text`: closed with
 * nothing after it (`label`), still open, or closed and followed (null).
 */
function titleEnd(text: string, close: Waiting): Waiting | null {
  for (let at = 0; at < text.length; at++) {
    const char = text.charAt(at);
    if (char === '\\') at++;
    else if (char === close) return text.slice(at + 1).trim() ? null : 'label';
  }
  return close;
}

/**
 * What ends an HTML block, lower-cased: `rawHtmlEnd`, or '' for a blank
 * line; how its lines read; and whether its first line already did.
 */
type HtmlBlock = { end: string; read: HtmlReading; closed: boolean };

/**
 * Lines of an HTML block as the reader shows them: the text between its
 * tags (`withoutTags`); nothing of a comment and the like; or as written,
 * blank lines aside, for a script, style or textarea, whose tags the reader
 * shows as text, as GitHub's tag filter has it.
 */
type HtmlReading = (lines: string) => string;
const htmlText: HtmlReading = (lines) => withoutTags(lines).replace(/\s+/g, ' ');
const hidden: HtmlReading = () => '';
const asWritten: HtmlReading = (lines) =>
  lines
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

/**
 * The HTML block a line's `content` starts, if any. As CommonMark has it, a
 * lone tag outside `BLOCK_HTML` starts one only where the line wouldn't
 * carry on an `open` paragraph or link definitions.
 */
function htmlBlock(content: string, open: boolean): HtmlBlock | null {
  const raw = RAW_HTML.exec(content);
  if (raw !== null) {
    const end = rawHtmlEnd(raw);
    const rest = content.slice(raw[0].length).toLowerCase();
    const read = end.startsWith('</') ? (end === '</pre>' ? htmlText : asWritten) : hidden;
    // `<!-->` and `<!--->` are whole comments.
    return { end, read, closed: rest.includes(end) || (raw[1] === '!--' && /^-?>/.test(rest)) };
  }
  if (BLOCK_HTML.test(content)) return { end: '', read: htmlText, closed: false };
  if (open || !content.startsWith('<')) return null;
  const tag = tagEnd(content, 0);
  return tag >= 0 && !content.slice(tag + 1).trim()
    ? { end: '', read: htmlText, closed: false }
    : null;
}

/** An HTML block's tag that can break into a paragraph, as CommonMark lists them. */
const BLOCK_HTML =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s>]|\/>|$)/i;

/**
 * HTML that ends at a line holding its end, not at a blank line: a comment,
 * `<?…?>`, a declaration, CDATA, or a script, pre, style or textarea element.
 */
const RAW_HTML = /^<(!--|\?|!\[CDATA\[|![A-Za-z]|(?:script|pre|style|textarea)(?![^\s>]))/i;

/** What ends the HTML `RAW_HTML` matched, lower-cased. */
function rawHtmlEnd([, opener = '']: RegExpExecArray): string {
  const name = opener.toLowerCase();
  return RAW_HTML_ENDS[name] ?? (name.startsWith('!') ? '>' : `</${name}>`);
}
const RAW_HTML_ENDS: Record<string, string> = { '!--': '-->', '?': '?>', '![cdata[': ']]>' };

/** A table's delimiter row, `| :-- | --: |`, when the line has a `|`. */
const DELIMITER_ROW = /^\s*(?:\|\s*)?:?-+:?\s*(?:\|\s*:?-+:?\s*)*(?:\|\s*)?$/;

/** `line` without the `#`s closing a heading, after a space. */
function withoutClosingHashes(line: string): string {
  const trimmed = line.trimEnd();
  let at = trimmed.length;
  while (at > 0 && trimmed.charAt(at - 1) === '#') at--;
  return at > 0 && at < trimmed.length && /\s/.test(trimmed.charAt(at - 1))
    ? trimmed.slice(0, at)
    : line;
}

/** A paragraph's text as the reader shows it; `notes` are the footnotes the page defines. */
function inline(line: string, notes: ReadonlySet<string>): string {
  // No part of a pattern here matches its own opener (`[`, `<`), so a failed
  // match never rescans what the next one will.
  // [[Target#Heading|Shown]], ![[file]], on one line: what it shows. A block reference shows nothing.
  const wikilinked = line.replace(
    /!?\[\[([^\][|#\n]*)(?:#([^\][|\n]*))?(?:\|([^\][\n]*))?\]\]/g,
    (_, target: string, heading: string | undefined, shown: string | undefined) =>
      shown ?? [target, heading?.startsWith('^') ? '' : heading].filter(Boolean).join(' '),
  );
  return withoutTags(
    withoutLinks(wikilinked, notes).replace(/<((?:https?|mailto):[^<>\s]*)>/g, '$1'),
  )
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '')
    .replace(/[*_~`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `line` with each link and image as the text it shows, which may hold
 * brackets, and without references to the footnotes in `notes`. A link is
 * `[text](url)`, `![alt](url)` or `[text][ref]`, its brackets and the
 * URL's parentheses balanced, none of them in inline code. As in
 * CommonMark, an image's alt text may hold links, but a link's text may
 * not: brackets around a link are text, and so is what follows them.
 * Linear: brackets and parentheses are paired in one pass, then the line is
 * read once, a link's URL or reference skipped whole, with labels read
 * again by `bracketless`.
 */
function withoutLinks(line: string, notes: ReadonlySet<string>): string {
  if (!line.includes('[')) return line;
  const closer = closers(line);
  const parts: string[] = [];
  // Brackets that may open a link or image, innermost last: where their text
  // ends, the part holding the `[` or `![`, and how many links came before.
  const open: { end: number; part: number; links: number; image: boolean }[] = [];
  let links = 0;
  let from = 0;
  let escaped = -1;
  for (let at = 0; at < line.length; at++) {
    // A link's URL can end past brackets opened before it; they're text.
    while ((open.at(-1)?.end ?? Infinity) < at) open.pop();
    const ending = open.at(-1);
    if (ending?.end === at) {
      open.pop();
      if (ending.image || ending.links === links) {
        if (!ending.image) links++;
        parts[ending.part] = '';
        parts.push(line.slice(from, at));
        at = closer[at + 1] ?? at;
        from = at + 1;
        continue;
      }
    }
    const char = line.charAt(at);
    if (char === '\\') escaped = ++at;
    if (char !== '[') continue;
    const end = closer[at] ?? -1;
    if (end < 0) continue;
    // A footnote reference, `[^label]`, shows nothing.
    if (
      line.charAt(at + 1) === '^' &&
      end > at + 2 &&
      bracketless(line, at + 2, end, '[] \t\n') &&
      notes.has(noteLabel(line.slice(at + 2, end)))
    ) {
      parts.push(line.slice(from, at));
      from = end + 1;
      at = end;
      continue;
    }
    const target = closer[end + 1] ?? -1;
    if (target < 0) continue;
    if (line.charAt(end + 1) === '[' && !bracketless(line, end + 2, target)) continue;
    const image = line.charAt(at - 1) === '!' && escaped !== at - 1;
    parts.push(line.slice(from, image ? at - 1 : at), image ? '![' : '[');
    from = at + 1;
    open.push({ end, part: parts.length - 1, links, image });
  }
  parts.push(line.slice(from));
  return parts.join('');
}

/**
 * Whether `line` has no bracket (or other of `stops`) from `start` up to
 * `end`, as a footnote's or reference's label must not; a footnote's has no
 * space, tab or line break either. Read up to the first: `withoutLinks`
 * asks only from just after a `[` or `[^`, at most twice for each `[`, so it
 * reads any character at most twice.
 */
function bracketless(line: string, start: number, end: number, stops = '[]'): boolean {
  let at = start;
  while (at < end && !stops.includes(line.charAt(at))) at++;
  return at === end;
}

/** For each `[` and `(` in `line` not escaped or in code, where the one closing it is, or -1. */
function closers(line: string): Int32Array {
  const closer = new Int32Array(line.length + 1).fill(-1);
  const code = inCode(line);
  const brackets: number[] = [];
  const parentheses: number[] = [];
  for (let at = 0; at < line.length; at++) {
    if (code[at]) continue;
    const char = line.charAt(at);
    const open = char === ']' ? brackets.pop() : char === ')' ? parentheses.pop() : undefined;
    if (open !== undefined) closer[open] = at;
    else if (char === '[') brackets.push(at);
    else if (char === '(') parentheses.push(at);
    else if (char === '\\') at++;
  }
  return closer;
}

/**
 * Which characters of `line` are inline code, backticks included: from a
 * run of backticks, not escaped or in an HTML tag begun before it, to the
 * next run exactly as long. Linear: tags are read as `withoutTags` reads
 * them, and for each length, the runs that could close one are passed over
 * once, in order.
 */
function inCode(line: string): Uint8Array {
  const code = new Uint8Array(line.length);
  if (!line.includes('`')) return code;
  // Where each run of backticks starts, by its length, and how many of each
  // are behind the reading.
  const runs = new Map<number, number[]>();
  for (const { 0: run, index } of line.matchAll(/`+/g)) {
    let starts = runs.get(run.length);
    if (!starts) runs.set(run.length, (starts = []));
    starts.push(index);
  }
  const passed = new Map<number, number>();
  for (let at = 0; at < line.length; at++) {
    const char = line.charAt(at);
    if (char === '\\') at++;
    if (char === '<') at = Math.max(at, tagEnd(line, at));
    if (char !== '`') continue;
    let end = at;
    while (line.charAt(end) === '`') end++;
    const starts = runs.get(end - at) ?? [];
    let next = passed.get(end - at) ?? 0;
    while ((starts[next] ?? Infinity) < end) next++;
    passed.set(end - at, next);
    const close = starts[next];
    if (close === undefined) {
      at = end - 1;
      continue;
    }
    code.fill(1, at, close + end - at);
    at = close + end - at - 1;
  }
  return code;
}

/**
 * `line` with each HTML tag (`tagEnd`) or comment not in inline code a
 * space, as the reader shows neither, an image's tag its alt text.
 *
 * Linear, though a tag that isn't one is read again from each `<` in its
 * quoted values. A reading is outside quotes, in `"` or in `'`. Outside
 * quotes, a quote mark starts a value or ends the reading, and a `<` ends
 * it; in quotes, only the closing mark counts. So a quote mark takes a
 * reading in it out, one outside in or to its end, and leaves one in the
 * other quote be: readings in different states never meet in one. A
 * reading starts outside quotes at a `<`, where any still going must be in
 * them, so at most three, one per state, read any character.
 */
function withoutTags(line: string): string {
  if (!line.includes('<')) return line;
  const code = inCode(line);
  let text = '';
  let from = 0;
  // Once a comment doesn't close, none after it can.
  let closes = true;
  for (let at = line.indexOf('<'); at >= 0; at = line.indexOf('<', at + 1)) {
    if (code[at]) continue;
    let end = -1;
    if (line.startsWith('<!--', at)) {
      // `<!-->` and `<!--->` are whole comments too.
      const close: number = closes ? line.indexOf('-->', at + 2) : -1;
      closes = close >= 0;
      if (closes) end = close + 2;
    } else end = tagEnd(line, at);
    if (end < 0) continue;
    // An image keeps its alt text, as a Markdown image does.
    const alt = IMAGE_TAG.test(line.slice(at, at + 5)) ? IMAGE_ALT.exec(line.slice(at, end)) : null;
    text += `${line.slice(from, at)} ${alt?.slice(1).find((value) => value !== undefined) ?? ''} `;
    from = end + 1;
    at = end;
  }
  return text + line.slice(from);
}

const IMAGE_TAG = /^<img[\s/>]/i;
/** An `<img>` tag's alt attribute's value, in one of the groups. */
const IMAGE_ALT = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/**
 * Where the HTML tag opened by the `<` at `start` ends, or -1 if it isn't
 * one. As in CommonMark, a tag is `<` or `</` and a name, then, opening,
 * attributes, each after a space: a name, and maybe `=` and a value,
 * unquoted or in quotes. Then `>`, or `/>` opening.
 */
function tagEnd(line: string, start: number): number {
  const closing = line.charAt(start + 1) === '/';
  let at = start + (closing ? 2 : 1);
  if (!/[A-Za-z]/.test(line.charAt(at))) return -1;
  at = past(line, at, /[A-Za-z0-9-]/);
  for (;;) {
    const spaced = past(line, at, /\s/);
    const char = line.charAt(spaced);
    if (char === '>') return spaced;
    if (!closing && line.startsWith('/>', spaced)) return spaced + 1;
    if (closing || spaced === at || !/[A-Za-z_:]/.test(char)) return -1;
    at = past(line, spaced, /[\w.:-]/);
    const equals = past(line, at, /\s/);
    if (line.charAt(equals) !== '=') continue;
    const value = past(line, equals + 1, /\s/);
    const quote = line.charAt(value);
    if (quote === '"' || quote === "'") {
      const end = line.indexOf(quote, value + 1);
      if (end < 0) return -1;
      at = end + 1;
    } else {
      at = past(line, value, /[^\s"'=<>`]/);
      if (at === value) return -1;
    }
  }
}

/** Where the run of characters in `line` from `at` that `chars` matches ends. */
function past(line: string, at: number, chars: RegExp): number {
  let end = at;
  while (end < line.length && chars.test(line.charAt(end))) end++;
  return end;
}
