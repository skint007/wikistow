// Query tables (ADR 0006, decision 7): a fenced code block labelled
// `wikistow-query` lists pages by their properties.
//
//     from: Recipes            a folder path in this space, or #tag; the whole space if left out
//     where: tried = true, servings >= 2
//     show: servings, cook_time
//     sort: cook_time desc     a key or `title`, then `asc` or `desc`
//     limit: 20                at most 500, 100 if left out
//
// `parsePageQuery` reads a block's text, or says in one line why it can't.
// `runPageQuery` lists the pages a query names among those it is given:
// the viewer's search index in the app, the published versions in a
// public copy. Both are pure and take time linear in what they're given.

import { findProperty, isPropertyName, type PropertyData } from './markdown/properties.ts';
import { foldTitle } from './links.ts';
import { hasTag } from './search.ts';

/** The language a query block's fence is labelled with. */
export const QUERY_LANGUAGE = 'wikistow-query';

/** A value written in a condition: a number, a date, true or false, or text. */
export type QueryLiteral =
  | { kind: 'number'; value: number }
  | { kind: 'date'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; value: string };

export type QueryOperator = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'has';

/** One condition of `where`: a property, by a name that matches its key as a reference's does. */
export type QueryCondition = { name: string; operator: QueryOperator; value: QueryLiteral };

/** A query as its block says it. */
export type PageQuery = {
  /** Where its pages are: a folder by its path, outermost first, a tag, or the whole space. */
  from: { folder: string[] } | { tag: string } | null;
  where: QueryCondition[];
  /** The columns after the page's title: names, as written. */
  show: string[];
  /** A property by name, or the page's title; `asc` unless asked otherwise. */
  sort: { by: { name: string } | 'title'; descending: boolean } | null;
  limit: number;
};

export type ParsedQuery = { ok: true; query: PageQuery } | { ok: false; error: string };

/** Rows a query lists when its block doesn't say. */
export const DEFAULT_LIMIT = 100;
/** The most rows a query lists. */
export const MAX_LIMIT = 500;
// What a block may hold, so a hostile one costs little: its text, its conditions and columns.
const MAX_SOURCE = 10_000;
const MAX_PARTS = 50;

const LINES = ['from', 'where', 'show', 'sort', 'limit'] as const;
type Line = (typeof LINES)[number];

const fail = (error: string): ParsedQuery => ({ ok: false, error });

/**
 * A query block's text as a query, or why it doesn't read, in one line.
 * Each line is `name: value`, with `from`, `where`, `show`, `sort` and
 * `limit` each at most once, in any order and any case; blank lines are
 * skipped. A name in a condition, a column or `sort` follows the rule a
 * reference's does (`isPropertyName`).
 */
export function parsePageQuery(source: string): ParsedQuery {
  if (source.length > MAX_SOURCE) return fail('The query is too long.');
  const given = new Map<Line, string>();
  const lines = source.split(/\r\n?|\n/);
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const name = (colon < 0 ? line : line.slice(0, colon)).trim().toLowerCase();
    if (colon < 0 || !(LINES as readonly string[]).includes(name)) {
      return fail(
        `Line ${i + 1} isn’t one of from:, where:, show:, sort: or limit:, each with what it takes after the colon.`,
      );
    }
    const key = name as Line;
    if (given.has(key)) return fail(`It says ${key}: twice.`);
    given.set(key, line.slice(colon + 1).trim());
  }
  const query: PageQuery = { from: null, where: [], show: [], sort: null, limit: DEFAULT_LIMIT };

  const from = given.get('from');
  if (from !== undefined) {
    const read = readFrom(from);
    if (typeof read === 'string') return fail(read);
    query.from = read;
  }
  const where = given.get('where');
  if (where !== undefined) {
    const parts = splitList(where);
    if (parts === null) return fail('A quote in where: isn’t closed.');
    if (parts.length > MAX_PARTS) return fail(`where: takes at most ${MAX_PARTS} conditions.`);
    for (const part of parts) {
      const condition = readCondition(part);
      if (typeof condition === 'string') return fail(condition);
      query.where.push(condition);
    }
  }
  const show = given.get('show');
  if (show !== undefined) {
    const names = show.split(',').map((name) => name.trim());
    if (names.length > MAX_PARTS) return fail(`show: takes at most ${MAX_PARTS} columns.`);
    for (const name of names) {
      if (!isPropertyName(name))
        return fail(`show: lists property names, and “${name}” isn’t one.`);
    }
    query.show = names;
  }
  const sort = given.get('sort');
  if (sort !== undefined) {
    // Its last word, if that is a direction; read without a pattern that could backtrack.
    const space = Math.max(sort.lastIndexOf(' '), sort.lastIndexOf('\t'));
    const last = sort.slice(space + 1).toLowerCase();
    const directed = space >= 0 && (last === 'asc' || last === 'desc');
    const name = (directed ? sort.slice(0, space) : sort).trim();
    const direction = directed ? last : 'asc';
    if (!isPropertyName(name)) {
      return fail('sort: takes a property name or title, then asc or desc if you like.');
    }
    query.sort = {
      by: name.toLowerCase() === 'title' ? 'title' : { name },
      descending: direction === 'desc',
    };
  }
  const limit = given.get('limit');
  if (limit !== undefined) {
    const count = /^\d{1,4}$/.test(limit) ? Number(limit) : NaN;
    if (!(count >= 1 && count <= MAX_LIMIT)) {
      return fail(`limit: takes a whole number from 1 to ${MAX_LIMIT}.`);
    }
    query.limit = count;
  }
  return { ok: true, query };
}

const unquoted = (text: string) =>
  text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;

function readFrom(text: string): PageQuery['from'] | string {
  if (text === '') return 'from: takes a folder’s path, or a #tag.';
  if (text.startsWith('#')) {
    const tag = text.slice(1).trim();
    return tag === '' || /\s/.test(tag) ? 'from: takes one #tag, with no spaces in it.' : { tag };
  }
  const folder = unquoted(text)
    .split('/')
    .map((part) => part.trim());
  return folder.some((part) => part === '')
    ? 'from: takes a folder’s path, its folders’ names between slashes.'
    : { folder };
}

/** `text` split at its commas outside double quotes, each part trimmed; null if a quote isn't closed. */
function splitList(text: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted) return null;
  parts.push(text.slice(start).trim());
  return parts;
}

// An operator, the longest first, outside quotes; or ` has `.
const OPERATORS = ['!=', '<=', '>=', '=', '<', '>'] as const;

function readCondition(text: string): QueryCondition | string {
  const shape = `“${text}” isn’t a condition: a property name, then =, !=, <, <=, >, >= or has, then a value.`;
  // The operator is the first outside quotes; a name has none in it.
  let at = -1;
  let operator: QueryOperator | null = null;
  const has = /[ \t]has[ \t]/i.exec(text);
  for (let i = 0; i < text.length && operator === null; i++) {
    if (text[i] === '"') break;
    if (has && has.index === i) {
      [at, operator] = [i, 'has'];
      break;
    }
    for (const candidate of OPERATORS) {
      if (text.startsWith(candidate, i)) {
        [at, operator] = [i, candidate];
        break;
      }
    }
  }
  if (operator === null) return shape;
  const name = text.slice(0, at).trim();
  const written = text.slice(at + (operator === 'has' ? 5 : operator.length)).trim();
  if (!isPropertyName(name) || written === '') return shape;
  const value = readLiteral(written);
  if (value === null) return shape;
  return { name, operator, value };
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?: ?(Z|[+-]\d{2}(?::?\d{2})?))?)?$/;

/**
 * A date as a moment, for comparing: a day alone at its start, a time
 * with no zone as written, one with a zone at that moment; null if `text`
 * isn't a date as property types read them.
 */
export function dateMoment(text: string): number | null {
  const [, year, month, day, hour = '0', minute = '0', second = '0', zone] = DATE.exec(text) ?? [];
  if (year === undefined) return null;
  const date = new Date(0);
  // Not `Date.UTC`, which reads years up to 99 as 1900 and on.
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  // A day the calendar hasn't, as 2024-02-30, isn't a date.
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  date.setUTCHours(Number(hour), Number(minute), Number(second));
  let moment = date.getTime();
  if (zone !== undefined && zone !== 'Z') {
    const [, sign, hours, minutes = '0'] = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone) ?? [];
    moment -= (Number(hours) * 60 + Number(minutes)) * (sign === '-' ? -1 : 1) * 60_000;
  }
  return Number.isNaN(moment) ? null : moment;
}

function readLiteral(text: string): QueryLiteral | null {
  if (text.startsWith('"')) {
    return text.length >= 2 && text.endsWith('"') && !text.slice(1, -1).includes('"')
      ? { kind: 'text', value: text.slice(1, -1) }
      : null;
  }
  if (text.includes('"')) return null;
  const lower = text.toLowerCase();
  if (lower === 'true' || lower === 'false') return { kind: 'boolean', value: lower === 'true' };
  if (NUMBER.test(text)) return { kind: 'number', value: Number(text) };
  const date = dateMoment(text);
  if (date !== null) return { kind: 'date', value: date };
  return { kind: 'text', value: text };
}

// Running

/** A page as a query reads it. */
export type QueryPage = {
  title: string;
  properties: readonly Readonly<PropertyData>[];
  /** The folders it is in, outermost first: the one it is directly in last. */
  folderIds: readonly string[];
};

/** A folder of the space, as a query's `from` names it. */
export type QueryFolder = { id: string; parentId: string | null; name: string | null };

/** A page a query lists, and its value for each column, if it has one. */
export type QueryRow<P> = { page: P; values: (Readonly<PropertyData> | undefined)[] };

export type QueryResult<P> =
  | {
      ok: true;
      /** The columns after the title, as `show` writes them. */
      columns: string[];
      rows: QueryRow<P>[];
      /** How many pages it found, its limit aside. */
      total: number;
    }
  | { ok: false; error: string };

/**
 * The pages `query` lists among `pages`, the space's pages a viewer sees,
 * in their order unless it sorts them: those in its folder, or the folders
 * under it, or tagged so; that meet every condition; sorted, missing
 * values last either way, then by title; up to its limit. Its folder is
 * found among `folders` by its whole path from the top, else by the
 * folders that end its path, as a wikilink's folders are; a path naming
 * none, or several, is an error.
 */
export function runPageQuery<P extends QueryPage>(
  query: PageQuery,
  { pages, folders }: { pages: readonly P[]; folders: readonly QueryFolder[] },
): QueryResult<P> {
  let listed = pages;
  const { from } = query;
  if (from && 'folder' in from) {
    const found = folderAt(from.folder, folders);
    if ('error' in found) return { ok: false, error: found.error };
    listed = pages.filter((page) => page.folderIds.includes(found.id));
  } else if (from) {
    listed = pages.filter((page) => hasTag(page.properties, from.tag));
  }
  const meets = listed.filter((page) =>
    query.where.every((condition) => holds(page.properties, condition)),
  );
  const sorted = query.sort ? sortedBy(meets, query.sort) : meets;
  return {
    ok: true,
    columns: query.show,
    rows: sorted.slice(0, query.limit).map((page) => ({
      page,
      values: query.show.map((name) => findProperty(page.properties, name)),
    })),
    total: meets.length,
  };
}

/** The folder at `path`, or why there is none. */
function folderAt(
  path: readonly string[],
  folders: readonly QueryFolder[],
): { id: string } | { error: string } {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  // Each folder's names from the top, as far as the folders given go.
  const pathOf = (folder: QueryFolder) => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let at: QueryFolder | undefined = folder; at && !seen.has(at.id);) {
      seen.add(at.id);
      names.unshift(foldTitle(at.name ?? ''));
      at = at.parentId === null ? undefined : byId.get(at.parentId);
    }
    return names;
  };
  const wanted = path.map(foldTitle);
  const paths = folders.map((folder) => ({ folder, names: pathOf(folder) }));
  const same = (names: string[], from: number) =>
    wanted.every((part, i) => names[from + i] === part);
  const whole = paths.filter(({ names }) => names.length === wanted.length && same(names, 0));
  const ending =
    whole.length > 0
      ? whole
      : paths.filter(
          ({ names }) => names.length >= wanted.length && same(names, names.length - wanted.length),
        );
  const shown = path.join('/');
  const [only] = ending;
  if (!only) return { error: `No folder here is at ${shown}.` };
  if (ending.length > 1)
    return { error: `More than one folder is at ${shown}; give more of its path.` };
  return { id: only.folder.id };
}

// A property's scalar as a condition reads it.
type Comparable = QueryLiteral;

function comparable(value: string | number | boolean, type: PropertyData['type']): Comparable {
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  const date = type === 'date' || type === 'list' ? dateMoment(value) : null;
  return date === null ? { kind: 'text', value } : { kind: 'date', value: date };
}

const textOf = (value: Comparable) =>
  value.kind === 'date' ? '' : String(value.value).toLocaleLowerCase('en');

/** Whether `value` equals `literal`: as numbers, dates or true and false alike, or as text whatever its case. */
function equal(value: Comparable, literal: QueryLiteral): boolean {
  if (literal.kind === 'text') {
    return value.kind !== 'date' && textOf(value) === literal.value.toLocaleLowerCase('en');
  }
  return value.kind === literal.kind && value.value === literal.value;
}

function ordered(value: Comparable, literal: QueryLiteral, operator: QueryOperator): boolean {
  if (literal.kind !== value.kind || (literal.kind !== 'number' && literal.kind !== 'date')) {
    return false;
  }
  const [a, b] = [value.value as number, literal.value];
  switch (operator) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    default:
      return a >= b;
  }
}

/** The scalars a property's value is: itself, or a list's items, those in a list of their own too. */
function scalars(property: Readonly<PropertyData>): Comparable[] {
  const { value, type } = property;
  const items: unknown[] = Array.isArray(value) ? value.flat() : [value];
  return items.flatMap((item) =>
    item === null || item === undefined || item === ''
      ? []
      : [comparable(item as string | number | boolean, type)],
  );
}

/**
 * Whether `properties` meet `condition`. `=` and `has` hold for a value
 * equal to it, or a list holding one; `!=` where `=` doesn't, a missing
 * value included. `<`, `<=`, `>` and `>=` compare a number or a date with
 * one of the same kind, never text or a list.
 */
function holds(properties: readonly Readonly<PropertyData>[], condition: QueryCondition): boolean {
  const property = findProperty(properties, condition.name);
  const values = property ? scalars(property) : [];
  switch (condition.operator) {
    case '=':
    case 'has':
      return values.some((value) => equal(value, condition.value));
    case '!=':
      return !values.some((value) => equal(value, condition.value));
    default: {
      if (!property || Array.isArray(property.value)) return false;
      const [value] = values;
      return value !== undefined && ordered(value, condition.value, condition.operator);
    }
  }
}

// How text sorts, whatever its case: made once, as each `localeCompare` makes its own.
const TEXT_ORDER = new Intl.Collator(undefined, { sensitivity: 'base' });

// Kinds of value as a sort orders them, before each other.
const RANK = { number: 0, date: 1, boolean: 2, text: 3 } as const;

function sortedBy<P extends QueryPage>(pages: readonly P[], sort: NonNullable<PageQuery['sort']>) {
  const keyed = pages.map((page, i) => {
    let key: Comparable | null;
    if (sort.by === 'title') key = { kind: 'text', value: page.title };
    else {
      const property = findProperty(page.properties, sort.by.name);
      const values = property ? scalars(property) : [];
      key =
        values.length === 0
          ? null
          : values.length === 1 || !Array.isArray(property?.value)
            ? (values[0] ?? null)
            : { kind: 'text', value: values.map((value) => String(value.value)).join(', ') };
    }
    return { page, i, key };
  });
  const direction = sort.descending ? -1 : 1;
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) {
      // Missing values last, whichever way it sorts; then as they came.
      return a.key === b.key ? a.i - b.i : a.key === null ? 1 : -1;
    }
    const rank = RANK[a.key.kind] - RANK[b.key.kind];
    if (rank !== 0) return rank * direction;
    const order =
      a.key.kind === 'text'
        ? TEXT_ORDER.compare(String(a.key.value), String(b.key.value))
        : Number(a.key.value) - Number(b.key.value);
    return order !== 0 ? order * direction : a.i - b.i;
  });
  return keyed.map(({ page }) => page);
}
