// A small part of Dataview's query language, as an imported vault's
// ```dataview blocks write it, read as a host.pages.query:
//
//     TABLE servings, cook_time AS "Time"   (or LIST)
//     FROM "Recipes"                         a folder, or #tag
//     WHERE tried = true AND servings >= 2   or contains(tags, "soup")
//     SORT file.mtime DESC                   file.name sorts by title,
//                                            file.mtime by when it was saved
//     LIMIT 10
//
// Anything else, such as FROM with OR, file.* fields but file.name and
// file.mtime, WHERE or SORT on a property named saved, which the host reads
// as when the page was saved, or expressions, gives a line saying what
// isn't read, and the block shows its text. The host reads file.mtime as
// `saved` in a plugin's query; an app from before it did refuses the query.

import type { PageQuery } from '@wikistow/plugin-sdk';

/** A column: the property it shows, and its heading. */
export type Column = { name: string; heading: string };

export type Dql =
  | { ok: true; kind: 'table' | 'list'; columns: Column[]; query: Omit<PageQuery, 'spaceId'> }
  | { ok: false; error: string };

const KEYWORDS = ['FROM', 'WHERE', 'SORT', 'LIMIT'] as const;
type Keyword = (typeof KEYWORDS)[number];

const fail = (error: string): Dql => ({ ok: false, error });

/** `text` split where `separator`, a sticky pattern, matches outside double quotes and brackets. */
function splitOutside(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '(') depth++;
    else if (!quoted && char === ')') depth--;
    else if (!quoted && depth === 0) {
      separator.lastIndex = i;
      const match = separator.exec(text);
      if (match) {
        parts.push(text.slice(start, i).trim());
        start = i + match[0].length;
        i = start - 1;
      }
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** A space before a clause's keyword, each clause starting at its keyword. */
const CLAUSE = /\s(?=(?:FROM|WHERE|SORT|LIMIT)\b)/iy;

/** When a page was saved, as Dataview names it, and a plugin's query takes it. */
export const MTIME = 'file.mtime';

/** A field as wikistow-query names it: `file.name` is the title; `file.mtime` the host takes. */
function fieldName(field: string): string | null {
  const name = field.trim();
  if (name.toLowerCase() === 'file.name') return 'title';
  if (name.toLowerCase() === MTIME) return MTIME;
  return /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]*$/u.test(name) ? name : null;
}

/**
 * A field as the host's query reads it, or null for a property named
 * `saved`, which the host reads as when the page was saved: in Dataview it
 * is the property, so it would filter or sort by the wrong thing.
 */
function queriedName(field: string): string | null {
  const name = fieldName(field);
  return name !== null && name.toLowerCase().replace(/[_\s-]+/g, ' ') === 'saved' ? null : name;
}

/** A value as wikistow-query writes it: a quoted text, a number, true or false, or a date. */
function valueOf(written: string): string | null {
  const value = written.trim();
  const date = /^date\((\d{4}-\d{2}-\d{2})\)$/i.exec(value);
  if (date?.[1]) return date[1];
  if (/^"[^"]*"$/.test(value)) return value;
  if (/^-?\d+(?:\.\d+)?$/.test(value) || /^(?:true|false)$/i.test(value)) return value;
  return null;
}

function condition(text: string): string | null {
  const contains = /^contains\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/i.exec(text);
  if (contains?.[1] && contains[2]) {
    const name = queriedName(contains[1]);
    const value = valueOf(contains[2]);
    return name && name !== 'title' && value ? `${name} has ${value}` : null;
  }
  const compared = /^(.+?)\s*(!=|<=|>=|=|<|>)\s*(.+)$/.exec(text);
  if (!compared?.[1] || !compared[2] || !compared[3]) return null;
  const name = queriedName(compared[1]);
  const value = valueOf(compared[3]);
  return name && name !== 'title' && value ? `${name} ${compared[2]} ${value}` : null;
}

/** A ```dataview block's text as a query, or a line saying what it can't read. */
export function readDql(source: string): Dql {
  // Its words, joined: Dataview reads lines as spaces.
  const text = source.replace(/\s+/g, ' ').trim();
  const head = /^(TABLE|LIST)\b\s*/i.exec(text);
  if (!head?.[1]) return fail('Only TABLE and LIST queries are read here.');
  const kind = head[1].toLowerCase() as 'table' | 'list';
  // Its columns, then each clause from its keyword to the next, outside quotes.
  const [fieldsText = '', ...rest] = splitOutside(` ${text.slice(head[0].length)}`, CLAUSE);
  const query: Omit<PageQuery, 'spaceId'> = {};
  const seen = new Set<Keyword>();
  for (const clause of rest) {
    const keyword = clause.split(' ')[0]?.toUpperCase() as Keyword;
    const body = clause.slice(keyword.length).trim();
    if (!KEYWORDS.includes(keyword) || seen.has(keyword))
      return fail(`“${clause}” isn’t read here.`);
    seen.add(keyword);
    if (keyword === 'FROM') {
      const folder = /^"([^"]+)"$/.exec(body);
      if (folder?.[1]) query.from = folder[1];
      else if (/^#[^\s#]+$/.test(body)) query.from = body;
      else return fail('FROM takes one "folder" or one #tag here.');
    } else if (keyword === 'WHERE') {
      const conditions = splitOutside(body, /\s+AND\s+/iy).map(condition);
      if (conditions.some((read) => read === null))
        return fail(
          'WHERE takes conditions joined by AND, as field = value or contains(field, value).',
        );
      query.where = conditions.join(', ');
    } else if (keyword === 'SORT') {
      const sort = /^(.+?)(?:\s+(ASC|DESC|ASCENDING|DESCENDING))?$/i.exec(body);
      const name = sort?.[1] ? queriedName(sort[1]) : null;
      if (!name)
        return fail(
          'SORT takes one field, then ASC or DESC; for when a page was saved, file.mtime.',
        );
      query.sort = `${name} ${sort?.[2]?.toUpperCase().startsWith('DESC') ? 'desc' : 'asc'}`;
    } else {
      const limit = /^\d{1,3}$/.test(body) ? Number(body) : NaN;
      if (!(limit >= 1 && limit <= 500)) return fail('LIMIT takes a number from 1 to 500.');
      query.limit = limit;
    }
  }
  const columns: Column[] = [];
  if (kind === 'table' && fieldsText !== '') {
    const fields = fieldsText.replace(/^WITHOUT ID\s*/i, '');
    for (const column of splitOutside(fields, /,/y)) {
      const named = /^(.+?)\s+AS\s+"([^"]*)"$/i.exec(column);
      const name = fieldName(named?.[1] ?? column);
      if (!name || name === 'title') return fail(`The column “${column}” isn’t read here.`);
      columns.push({ name, heading: named?.[2] ?? name });
    }
  }
  return { ok: true, kind, columns, query };
}
