import {
  isAlias,
  isMap,
  isScalar,
  isNode,
  isSeq,
  parseDocument,
  visit,
  type Document,
  type Node,
  type Scalar,
  type YAMLSeq,
} from 'yaml';
import { VARIABLE_NAME } from '../templates.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { parseWikilink, type Wikilink } from './wikilink.ts';

// Page properties (ADR 0006, decisions 1 to 4): a frontmatter block read as
// YAML 1.2, and edits that change only the characters they're about.
//
// - **Reading.** A block's properties are the top-level keys of a map, in
//   order. A block that doesn't read as YAML, or whose top level isn't a
//   map, has none, only a short reason why.
// - **Types** come from the values: a list (of scalars, or of lists of
//   them), a number, `true` or `false`, a date (`YYYY-MM-DD`, or with a
//   time), a web address, one wikilink alone (`"[[Page]]"`), otherwise text.
//   Any other value is text, its source: a nested map or an alias,
//   read-only, or a scalar that isn't JSON (`.inf`), which can be replaced.
// - **Editing in place.** A value is editable unless it is on more than one
//   line, a block scalar, an anchor, an alias or tagged, has a comment
//   inside it, or isn't a scalar or a list of them. An edit replaces one
//   value, one key, or one property's lines; a new key is a line before the
//   closing delimiter. Every other character stays as it was. Each edit is
//   read back before it is returned: if it doesn't read as the old
//   properties with only that change, a safer quoting is tried, and failing
//   that the edit is refused.
// - **Names.** A reference's name follows the template-variable rule, and
//   matches a key whatever its case, with `_`, `-` and spaces alike. The
//   first matching key wins.
//
// Offsets are UTF-16, into the block as `splitFrontmatter` returns it,
// delimiter lines included.

/** What a property's value reads as. */
export type PropertyType = 'list' | 'number' | 'boolean' | 'date' | 'url' | 'wikilink' | 'text';

/** A scalar value: `null` for an empty one (`key:`). */
export type PropertyScalar = string | number | boolean | null;

/** A property's value as plain data: a scalar, or a list of scalars and lists of scalars. */
export type PropertyValue =
  | PropertyScalar
  | readonly (PropertyScalar | readonly PropertyScalar[])[];

/** A property as plain, JSON-safe data: what search keeps and a reference shows. */
export type PropertyData = { key: string; type: PropertyType; value: PropertyValue };

/** Where some text is, from `start` up to `end`. */
export type PropertySpan = { start: number; end: number };

/** A property as read from its block. */
export type Property = PropertyData & {
  keySpan: PropertySpan;
  /** Its value's source: for an empty value, the empty span after the colon. */
  valueSpan: PropertySpan;
  /** Whether `setProperty` can change the value where it is. */
  editable: boolean;
};

/** A block's properties, or why it has none: not YAML, or not a map. */
export type ReadProperties = { ok: true; properties: Property[] } | { ok: false; reason: string };

/** An edit's result: the whole new block, or why it can't be made. */
export type PropertyEdit = { ok: true; frontmatter: string } | { ok: false; reason: string };

/** A block's properties, in order. No block has none. */
export function readProperties(frontmatter: string | null): ReadProperties {
  const read = readBlock(frontmatter);
  return read.ok ? { ok: true, properties: read.entries.map((entry) => entry.property) } : read;
}

/** A block's properties as plain data, for an index to keep; none when it doesn't read. */
export function propertyData(frontmatter: string | null): PropertyData[] {
  const read = readBlock(frontmatter);
  return read.ok
    ? read.entries.map(({ property: { key, type, value } }) => ({ key, type, value }))
    : [];
}

/**
 * `frontmatter` with `key` (exactly as written) set to `value`, or added at
 * its end when it has no such key. A value is written so that it reads back
 * as given: a string that would read as a number or `true` is quoted, so
 * `'35'` keeps a value text and `35` makes it a number. A list replaces a
 * list in its style, its unchanged items as written; a list where there was
 * none is a flow list. A string keeps its quoting where that can hold it.
 * With no block (`null`), the result is a new one, with `lineBreak`.
 */
export function setProperty(
  frontmatter: string | null,
  key: string,
  value: PropertyValue,
  lineBreak: '\n' | '\r\n' = '\n',
): PropertyEdit {
  if (!isValue(value)) return refused('A property holds text, a number, true or false, or a list.');
  const block = frontmatter ?? `---${lineBreak}---${lineBreak}`;
  const read = readBlock(block);
  if (!read.ok) return read;
  if (read.flow) return refused(FLOW_MAP);
  const before = read.entries.map(asRead);
  const entry = read.entries.find(({ property }) => property.key === key);
  if (!entry) {
    if (key === '') return refused('A property needs a name.');
    const taken = read.entries.find((other) => other.joined === key);
    if (taken) return refused(`There is already a property ${taken.property.key}.`);
    const at = read.closeStart;
    const candidates = keyTexts(key, 'PLAIN').flatMap((keyText) =>
      valueTexts(value, null).map((valueText) => {
        const line = `${read.indent}${keyText}:${valueText === '' ? '' : ` ${valueText}`}${read.lineBreak}`;
        return block.slice(0, at) + line + block.slice(at);
      }),
    );
    return firstRead(candidates, [...before, { key, value, source: false }]);
  }
  const { property } = entry;
  // A value shown as its source isn't that text, so no value is the one it has.
  if (!entry.source && sameValue(property.value, value)) return { ok: true, frontmatter: block };
  if (!property.editable) return refused(entry.lock ?? UNSAFE);
  const expected = before.map((old, i) =>
    read.entries[i] === entry ? { key, value, source: false } : old,
  );
  return firstRead(valueEdits(block, read.base, entry, value), expected);
}

/** `frontmatter` with the key `key` (exactly as written) renamed `to`, in the key's own quoting where it can. */
export function renameProperty(frontmatter: string, key: string, to: string): PropertyEdit {
  const read = readBlock(frontmatter);
  if (!read.ok) return read;
  if (read.flow) return refused(FLOW_MAP);
  const entry = read.entries.find(({ property }) => property.key === key);
  if (!entry) return refused(`There is no property ${key}.`);
  if (to === key) return { ok: true, frontmatter };
  if (to === '') return refused('A property needs a name.');
  const taken = read.entries.find(
    (other) => other !== entry && (other.property.key === to || other.joined === to),
  );
  if (taken) return refused(`There is already a property ${taken.property.key}.`);
  // Aliases elsewhere name the key's anchor, and would read as the new name.
  if (entry.key.anchor) return refused('The key has an anchor.');
  const style = entry.key.type;
  if (style !== 'PLAIN' && style !== 'QUOTE_DOUBLE' && style !== 'QUOTE_SINGLE') {
    return refused('The key is on more than one line.');
  }
  const { start, end } = entry.property.keySpan;
  const expected = read.entries.map((other) =>
    other === entry ? { ...asRead(other), key: to } : asRead(other),
  );
  const candidates = keyTexts(to, style).map(
    (text) => frontmatter.slice(0, start) + text + frontmatter.slice(end),
  );
  return firstRead(candidates, expected);
}

/**
 * `frontmatter` without the key `key` (exactly as written): its lines go,
 * from its key's to its value's last, with the comment lines indented
 * under it, unless a block of text above would then read them as its own.
 */
export function removeProperty(frontmatter: string, key: string): PropertyEdit {
  const read = readBlock(frontmatter);
  if (!read.ok) return read;
  if (read.flow) return refused(FLOW_MAP);
  const entry = read.entries.find(({ property }) => property.key === key);
  if (!entry) return refused(`There is no property ${key}.`);
  const start = frontmatter.lastIndexOf('\n', entry.property.keySpan.start - 1) + 1;
  // Before the key on its line, only indentation, `?` and its anchor or tag.
  if (
    !/^[ \t]*(?:\?[ \t]+)?(?:[&!]\S*[ \t]+)*$/.test(
      frontmatter.slice(start, entry.property.keySpan.start),
    )
  ) {
    return refused('The key doesn’t start its line.');
  }
  // An alias reads as written whatever it names, so reading the block
  // back can't tell whether one lost its anchor, or now names another.
  if (read.aliased && (anchored(entry.key) || anchored(entry.value))) {
    return refused('It holds an anchor, which aliases may name.');
  }
  const valueEnd = entry.property.valueSpan.end;
  const newline = frontmatter.indexOf('\n', valueEnd - 1);
  const end = newline < 0 || newline >= read.closeStart ? read.closeStart : newline + 1;
  // Comment lines indented under the key go with it, unless the block
  // then reads differently: left behind, a block of text before them could
  // read them as its own.
  const under = new RegExp(
    `^(?:[ \\t]{${(/^[ \t]*/.exec(frontmatter.slice(start))?.[0].length ?? 0) + 1},}#[^\\n]*\\n)*`,
  );
  const withComments = end + (under.exec(frontmatter.slice(end, read.closeStart))?.[0].length ?? 0);
  const candidates = [...new Set([withComments, end])].map(
    (to) => frontmatter.slice(0, start) + frontmatter.slice(to),
  );
  return firstRead(
    candidates,
    read.entries.flatMap((other) => (other === entry ? [] : [asRead(other)])),
  );
}

/**
 * A name as names match keys: case folded, `_`, `-` and spaces alike, and
 * an accent typed apart from its letter (NFD) the same as one with it (NFC).
 */
export const foldPropertyName = (name: string) =>
  name.normalize('NFC').toLocaleLowerCase('en').replace(/[_ -]/g, ' ');

const NAME = new RegExp(`^${VARIABLE_NAME.source}$`, 'u');

/** Whether `name` can name a property in a reference: the template-variable rule (`VARIABLE_NAME`). */
export const isPropertyName = (name: string) => NAME.test(name);

/** The first of `properties` whose key matches `name`, or undefined. */
export function findProperty<P extends { key: string }>(
  properties: readonly P[],
  name: string,
): P | undefined {
  const folded = foldPropertyName(name);
  return properties.find((property) => foldPropertyName(property.key) === folded);
}

const LINK_ALONE = /^\[\[[^[\]\n]+\]\]$/;

/**
 * The wikilink a value is, when it is exactly one (`[[Page]]`, with a
 * heading or text of its own if it has them), or null. Embeds and block
 * references aren't page links.
 */
export function propertyWikilink(value: PropertyValue): Wikilink | null {
  if (typeof value !== 'string' || !LINK_ALONE.test(value)) return null;
  const link = parseWikilink(value);
  if (!link || link.unsupported || link.target === '') return null;
  const { source, target, heading, shown, embed } = link;
  return { source, target, heading, shown, embed };
}

// Reading

const FLOW_MAP = 'The properties are written as one flow map, { … }.';
const UNSAFE = 'That can’t be written there without changing other text.';
const COMMENT = 'It has a comment inside it.';
const TOO_LONG = 'It is too long to read as properties.';
const UNREADABLE = 'It isn’t text, a number, true or false, or a list of them.';

// `text` without the spaces, tabs and line breaks it ends with: YAML's
// blanks, not all Unicode spaces, which a plain scalar may end with. A
// loop, as a regex ending `+$` would retry every blank in a long run.
function trimBlanks(text: string): string {
  return text.slice(0, blanksStart(text, 0, text.length));
}

// Where the blanks `text` has before `end`, and after `start`, begin.
function blanksStart(text: string, start: number, end: number): number {
  let at = end;
  for (let code = text.charCodeAt(at - 1); at > start; code = text.charCodeAt(--at - 1)) {
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d && code !== 0x0a) break;
  }
  return at;
}

// Where a value's source from `start` ends: the parser's `end`, less the
// blanks, and the comment lines no deeper than its key's, after it. The
// parser has an empty node at a value's end take in the comments after.
function sourceEnd(yaml: string, start: number, end: number, column: number): number {
  for (let stop = end; ;) {
    stop = blanksStart(yaml, start, stop);
    const line = yaml.lastIndexOf('\n', stop - 1) + 1;
    let at = line;
    while (yaml[at] === ' ' || yaml[at] === '\t') at++;
    if (line <= start || yaml[at] !== '#' || at - line > column) return stop;
    stop = line;
  }
}

// Where the text after `from` goes on past spaces, line breaks and comments.
function pastBlanks(yaml: string, from: number): number {
  for (let at = from; at < yaml.length; at++) {
    const char = yaml[at];
    if (char === '#') {
      at = yaml.indexOf('\n', at);
      if (at < 0) return yaml.length;
    } else if (char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n') return at;
  }
  return yaml.length;
}

// Just after the colon that follows a key ending at `from`, or -1.
function colonAfter(yaml: string, from: number): number {
  const at = pastBlanks(yaml, from);
  return yaml[at] === ':' ? at + 1 : -1;
}

const refused = (reason: string) => ({ ok: false, reason }) as const;

// A property as read, with what its edits need: its nodes, where its
// colon ends (or -1), why its value can't be edited in place if it can't,
// and whether the value is shown as its source.
type Entry = {
  property: Property;
  key: Scalar;
  // The key as an object reading the block has it.
  joined: string;
  value: Node | null;
  colon: number;
  lock: string | null;
  source: boolean;
};

type ReadBlock =
  | {
      ok: true;
      entries: Entry[];
      // Where the YAML starts in the block, and where its closing line does.
      base: number;
      closeStart: number;
      // A top-level flow map, `{ a: 1 }`, which only the text edits.
      flow: boolean;
      // Whether an alias names an anchor somewhere.
      aliased: boolean;
      // A new key's indentation and line break: the map's and the opening line's.
      indent: string;
      lineBreak: string;
    }
  | { ok: false; reason: string };

function readBlock(frontmatter: string | null): ReadBlock {
  if (frontmatter === null) return readBlock('---\n---\n');
  const open = /^---\r?\n/.exec(frontmatter)?.[0];
  if (open === undefined) return refused('It isn’t a frontmatter block.');
  const rest = frontmatter.slice(open.length);
  const base = open.length;
  const closeStart = base + rest.replace(/\n$/, '').lastIndexOf('\n') + 1;
  const yaml = frontmatter.slice(base, closeStart);
  if (yaml.length > MAX_YAML) return refused(TOO_LONG);
  const doc = parseDocument(yaml, PARSING);
  const [error] = doc.errors;
  if (error) {
    // Some complaints quote the source, which can be as long as the block.
    const [message = ''] = error.message.split('\n');
    const short = message.length > 120 ? `${message.slice(0, 119)}…` : message;
    return refused(`${short} (line ${lineOf(yaml, error.pos[0])}).`);
  }
  const { problem, aliased } = checked(doc, yaml);
  if (problem) return refused(problem);
  const lineBreak = open.endsWith('\r\n') ? '\r\n' : '\n';
  const map = doc.contents;
  if (map === null) {
    return { ok: true, entries: [], base, closeStart, flow: false, aliased, indent: '', lineBreak };
  }
  if (!isMap(map)) {
    return refused(
      isSeq(map)
        ? 'It holds a list, not keys and values.'
        : 'It holds one value, not keys and values.',
    );
  }
  const sourceOf = (node: Node) => {
    const [start, end] = node.range ?? [0, 0];
    return trimBlanks(yaml.slice(start, end));
  };
  // The map's line's indentation, before any `?`, anchor or tag.
  const firstStart = map.range?.[0] ?? 0;
  const indent = /^[ \t]*/.exec(yaml.slice(yaml.lastIndexOf('\n', firstStart - 1) + 1))?.[0] ?? '';
  const entries: Entry[] = [];
  // Keys as written and as a YAML reader's object has them: `1` and
  // `"1"`, or `0x1F` and `31`, differ to YAML but would be one key.
  const keys = new Set<string>();
  for (const pair of map.items) {
    const key = pair.key;
    if (!isScalar(key) || !key.range) return refused('A key isn’t plain text.');
    const value = (pair.value ?? null) as Node | null;
    const keySpan = { start: base + key.range[0], end: base + key.range[1] };
    const colon = value ? colonAfter(yaml, key.range[1]) : -1;
    // An empty value is at its colon: the parser has it after any comment.
    const empty = !value?.range || value.range[0] === value.range[1];
    const at = base + (colon < 0 ? key.range[1] : colon);
    // A value's source from its anchor or tag, which the parser has it after.
    const [from = 0, to = 0] = value?.range ?? [];
    const first =
      (value?.anchor || value?.tag) && colon >= 0 ? Math.min(pastBlanks(yaml, colon), from) : from;
    const source = yaml.slice(first, sourceEnd(yaml, first, to, indent.length));
    const valueSpan =
      value?.range && !empty
        ? { start: base + first, end: base + first + source.length }
        : { start: at, end: at };
    const read = value === null ? null : valueOf(value);
    const lock = map.flow
      ? FLOW_MAP
      : value === null
        ? 'It has no value after its key.'
        : (lockOf(value, yaml) ?? (read === undefined && !isScalar(value) ? UNREADABLE : null));
    const data =
      read === undefined
        ? { type: 'text' as const, value: source }
        : { type: typeOf(read), value: read };
    const written = typeof key.value === 'string' ? key.value : sourceOf(key);
    const joined = objectKey(key, written);
    if (keys.has(written) || keys.has(joined)) {
      return refused(`Map keys must be unique (line ${lineOf(yaml, key.range[0])}).`);
    }
    keys.add(written).add(joined);
    entries.push({
      property: {
        key: written,
        ...data,
        keySpan,
        valueSpan,
        editable: lock === null,
      },
      key,
      value,
      joined,
      colon: colon < 0 ? -1 : base + colon,
      lock,
      source: read === undefined,
    });
  }
  return {
    ok: true,
    entries,
    base,
    closeStart,
    flow: map.flow ?? false,
    aliased,
    indent,
    lineBreak,
  };
}

// A key as a YAML reader's object has it: `0x1F` as `31`, `~` as the
// empty string. A value of another kind (a tagged date, say) as written.
function objectKey({ value }: Scalar, written: string): string {
  if (value === null) return '';
  const plain = ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
  return plain ? String(value as string | number | boolean | bigint) : written;
}

// The longest YAML read, in UTF-16 code units: far more than any person
// writes, and little enough that reading and editing it take a moment.
const MAX_YAML = 64 * 1024;

// YAML 1.2. The parser's own checks for duplicate keys, and the source
// line it quotes with each complaint, take time in the square of the
// block's size, so `checked` and `lineOf` do what's needed of them.
const PARSING = { version: '1.2', uniqueKeys: false, prettyErrors: false } as const;

// The line `offset` in the YAML is on, counting the opening delimiter's as 1.
const lineOf = (yaml: string, offset: number) => yaml.slice(0, offset).split('\n').length + 1;

// What the parser, so set, lets through that YAML doesn't allow, or null:
// a key twice in one map, or an alias naming no anchor before it. And
// whether the block has aliases.
function checked(doc: Document.Parsed, yaml: string): { problem: string | null; aliased: boolean } {
  const anchors = new Set<string>();
  let problem: string | null = null;
  let aliased = false;
  visit(doc, (_, node) => {
    if (isNode(node) && node.anchor) anchors.add(node.anchor);
    aliased ||= isAlias(node);
    if (isAlias(node) && !anchors.has(node.source)) {
      problem = `An alias names no anchor before it (line ${lineOf(yaml, node.range?.[0] ?? 0)}).`;
    }
    if (isMap(node)) {
      const keys = new Set<unknown>();
      for (const { key } of node.items) {
        if (!isScalar(key)) continue;
        if (keys.has(key.value)) {
          problem = `Map keys must be unique (line ${lineOf(yaml, key.range?.[0] ?? 0)}).`;
          break;
        }
        keys.add(key.value);
      }
    }
    return problem === null ? undefined : visit.BREAK;
  });
  return { problem, aliased };
}

// Whether `node` or any node in it has an anchor.
function anchored(node: Node | null): boolean {
  let found = false;
  visit(node, (_, child) => {
    found = isNode(child) && child.anchor !== undefined;
    return found ? visit.BREAK : undefined;
  });
  return found;
}

// A node's value as plain data, or undefined when it isn't a scalar or a
// list of scalars and lists of scalars: a map, a tagged binary, a
// non-finite number, an alias. An alias isn't followed: a few lines of
// them, each naming a long list, would make a value far larger than its
// block, and finding what each names walks the whole document.
function valueOf(node: Node, depth = 0): PropertyValue | undefined {
  if (isScalar(node)) {
    const { value } = node;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    // A number JSON can't hold, or an integer written out in more digits
    // than it holds exactly, is its source.
    const exact =
      Number.isSafeInteger(value) || !/^[-+]?(?:0x[\da-f]+|0o[0-7]+|\d+)$/i.test(node.source ?? '');
    return typeof value === 'number' && Number.isFinite(value) && exact ? value : undefined;
  }
  if (!isSeq(node) || depth > 1) return undefined;
  const items: (PropertyScalar | PropertyScalar[])[] = [];
  for (const item of (node as YAMLSeq<Node>).items) {
    const read = valueOf(item, depth + 1);
    if (read === undefined) return undefined;
    items.push(read as PropertyScalar | PropertyScalar[]);
  }
  return items;
}

// Why a value can't be replaced where it is, or null when it can.
function lockOf(node: Node, yaml: string, item = false): string | null {
  if (isAlias(node)) return 'It is an alias of another value.';
  if (node.anchor) return 'It has an anchor.';
  if (node.tag) return 'It has a YAML tag.';
  if (node.commentBefore) return COMMENT;
  // An item's comment is inside its list.
  if (item && node.comment) return COMMENT;
  const [start, end] = node.range ?? [0, 0];
  const multiLine = trimBlanks(yaml.slice(start, end)).includes('\n');
  if (isScalar(node)) {
    if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')
      return 'It is a block of lines.';
    return multiLine ? 'It is on more than one line.' : null;
  }
  if (!isSeq(node)) return 'It holds keys and values of its own.';
  const seq = node as YAMLSeq<Node>;
  if (seq.flow ? multiLine : item) return 'It is a list on more than one line.';
  if (!seq.flow && seq.comment) return COMMENT;
  for (const child of seq.items) {
    if (!isScalar(child) && !(isSeq(child) && !item)) return UNREADABLE;
    const lock = lockOf(child, yaml, true);
    if (lock) return lock;
  }
  return null;
}

const DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?: ?(?:Z|[+-]\d{2}(?::?\d{2})?))?)?$/;

function isDate(text: string): boolean {
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = DATE.exec(text) ?? [];
  if (year === undefined) return false;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return (
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60
  );
}

const isUrl = (text: string) => /^https?:\/\/\S+$/i.test(text) && URL.canParse(text);

function typeOf(value: PropertyValue): PropertyType {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value !== 'string') return 'text';
  if (isDate(value)) return 'date';
  if (isUrl(value)) return 'url';
  return propertyWikilink(value) ? 'wikilink' : 'text';
}

// Writing

const isScalarValue = (value: unknown): value is PropertyScalar =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

const isValue = (value: unknown): value is PropertyValue =>
  isScalarValue(value) ||
  (Array.isArray(value) &&
    value.every(
      (item) => isScalarValue(item) || (Array.isArray(item) && item.every(isScalarValue)),
    ));

function sameValue(a: PropertyValue, b: PropertyValue): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  return a.length === b.length && a.every((item, i) => sameValue(item, b[i] as PropertyValue));
}

// A property as an edit expects to read it back: its key, its value, and
// whether that is its source, so text can't pass for a map, an alias or
// a number written out in the same characters.
type Expected = { key: string; value: PropertyValue; source: boolean };

const asRead = ({ property: { key, value }, source }: Entry): Expected => ({ key, value, source });

// The first of `candidates` that still splits off a page whole and reads
// back as `expected`, or why none can be.
function firstRead(candidates: Iterable<string>, expected: readonly Expected[]): PropertyEdit {
  let long = false;
  for (const block of candidates) {
    if (splitFrontmatter(block).frontmatter !== block) continue;
    const read = readBlock(block);
    long ||= !read.ok && read.reason === TOO_LONG;
    if (!read.ok || read.entries.length !== expected.length) continue;
    const same = read.entries.every(({ property, source }, i) => {
      const want = expected[i];
      return (
        want !== undefined &&
        property.key === want.key &&
        source === want.source &&
        sameValue(property.value, want.value)
      );
    });
    if (same) return { ok: true, frontmatter: block };
  }
  return refused(long ? 'It would be too long to read as properties.' : UNSAFE);
}

type Style = 'PLAIN' | 'QUOTE_DOUBLE' | 'QUOTE_SINGLE';

// Text outside YAML's printable characters, and the tab, the line and
// paragraph separators and the byte-order mark, which some readers take
// as breaks: written only as escapes, in double quotes.
const UNPRINTABLE =
  /[^\x20-\x7e\xa0-\u{2027}\u{202a}-\u{d7ff}\u{e000}-\u{fefe}\u{ff00}-\u{fffd}\u{10000}-\u{10ffff}]/u;
const ESCAPED =
  /[\\"]|[^\x20-\x7e\xa0-\u{2027}\u{202a}-\u{d7ff}\u{e000}-\u{fefe}\u{ff00}-\u{fffd}\u{10000}-\u{10ffff}]/gu;

const doubleQuoted = (text: string) =>
  `"${text.replace(ESCAPED, (char) =>
    char === '\\' || char === '"'
      ? `\\${char}`
      : `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  )}"`;

const singleQuoted = (text: string) => `'${text.replace(/'/g, "''")}'`;

// The ways to write a scalar, most like `style` first. Plain text that
// reads as something else is caught when it is read back.
function scalarTexts(value: PropertyScalar, style: Style | null): string[] {
  if (typeof value === 'number') {
    // An integer past what's exact, in digits, would read as its source.
    return [
      Number.isSafeInteger(value) || !Number.isInteger(value)
        ? String(value)
        : value.toExponential(),
    ];
  }
  if (typeof value !== 'string') return [value === null ? 'null' : String(value)];
  if (UNPRINTABLE.test(value) || style === 'QUOTE_DOUBLE') return [doubleQuoted(value)];
  if (style === 'QUOTE_SINGLE') return [singleQuoted(value), doubleQuoted(value)];
  return value === '' ? [doubleQuoted(value)] : [value, doubleQuoted(value)];
}

type Context = 'block' | 'flow';

// Whether `text` reads as `value` on its own: in a flow list, or in a
// block (as a list item, which reads plain text as a map's value does).
function readsAs(text: string, value: PropertyScalar, context: Context): boolean {
  const doc = parseDocument(context === 'flow' ? `[${text}]` : `- ${text}`, PARSING);
  const list = doc.contents;
  const item = isSeq(list) && list.items.length === 1 ? (list.items[0] as Node) : null;
  return doc.errors.length === 0 && isScalar(item) && item.value === value;
}

// The ways to write a key, most like `style` first: plain only when it
// reads as that text, so a key such as `0x10` or `~` stays a string to
// every reader, and `<<` isn't a merge key to those that have them.
const keyTexts = (key: string, style: Style) => {
  const texts = scalarTexts(key, style).filter(
    // Nor a line starting `---` or `...`, which some readers take for the
    // block's end.
    (text) => text !== '<<' && !/^(?:---|\.\.\.)/.test(text) && readsAs(text, key, 'block'),
  );
  return texts.length > 0 ? texts : [doubleQuoted(key)];
};

// A scalar written anew, in `style` if it reads back as itself there.
const scalarText = (value: PropertyScalar, style: Style | null, context: Context) =>
  scalarTexts(value, style).find((text) => readsAs(text, value, context)) ??
  doubleQuoted(String(value));

// How a scalar node is quoted, if it is one written on its line.
const styleOf = (node: Node | null | undefined): Style | null =>
  isScalar(node) &&
  (node.type === 'PLAIN' || node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE')
    ? node.type
    : null;

// How a list's new string items are quoted: as its first string item is.
const itemStyle = (seq: YAMLSeq<Node>) =>
  styleOf(seq.items.find((item) => isScalar(item) && typeof item.value === 'string'));

type Item = PropertyScalar | readonly PropertyScalar[];

// A list item written anew; a list in it is a flow list.
const itemText = (item: Item, style: Style | null, context: Context) =>
  Array.isArray(item)
    ? `[${item.map((inner: PropertyScalar) => scalarText(inner, style, 'flow')).join(', ')}]`
    : scalarText(item as PropertyScalar, style, context);

// The ways to write `value` anew as a map's value on its line: a scalar,
// or a flow list. An empty value is nothing at all.
function valueTexts(value: PropertyValue, style: Style | null): string[] {
  // `null` where nothing at all wouldn't read, as before a tab-only line.
  if (value === null) return ['', 'null'];
  if (!Array.isArray(value)) {
    const scalar = value as PropertyScalar;
    return [...new Set([scalarText(scalar, style, 'block'), ...scalarTexts(scalar, style)])];
  }
  const list = (quote: Style | null) =>
    `[${(value as readonly Item[]).map((item) => itemText(item, quote, 'flow')).join(', ')}]`;
  return [...new Set([list(style), list('QUOTE_DOUBLE')])];
}

// The blocks `setProperty` tries for an editable entry, most like it first.
function* valueEdits(
  block: string,
  base: number,
  entry: Entry,
  value: PropertyValue,
): Generator<string> {
  const { valueSpan } = entry.property;
  const node = entry.value as Node;
  const replace = (start: number, end: number, text: string) =>
    block.slice(0, start) + text + block.slice(end);
  // From just after the key's colon: an empty value, and a scalar or a
  // flow list where a block list was.
  const { colon } = entry;
  const afterColon = (text: string) => replace(colon, valueSpan.end, text === '' ? '' : ` ${text}`);
  const seq = isSeq(node) ? (node as YAMLSeq<Node>) : null;
  if (value === null || valueSpan.start === valueSpan.end) {
    for (const text of valueTexts(value, null)) yield afterColon(text);
    return;
  }
  if (seq && Array.isArray(value) && (seq.flow || value.length > 0)) {
    for (const style of [itemStyle(seq), 'QUOTE_DOUBLE' as const]) {
      const text = listText(
        block,
        base,
        seq,
        entry.property.value as readonly Item[],
        value,
        style,
      );
      yield replace(valueSpan.start, valueSpan.end, text);
    }
  }
  const style = seq ? itemStyle(seq) : styleOf(node);
  for (const text of valueTexts(value, style)) {
    yield seq && !seq.flow ? afterColon(text) : replace(valueSpan.start, valueSpan.end, text);
  }
}

// A source range of the YAML as offsets into the block.
const spanOf = (base: number, node: Node) => {
  const [start = 0, end = 0] = node.range ?? [];
  return { start: base + start, end: base + end };
};

/**
 * `next` in place of the list `seq` (of `old`), in its style. Items equal
 * to old ones, in order, are kept as written, and so is the text between
 * two kept side by side. Others are written anew, in `style`, joined as
 * its first two items are: in a flow list, between its brackets; in a
 * block list, each from a `-` on its own line, in the list's indentation.
 */
function listText(
  block: string,
  base: number,
  seq: YAMLSeq<Node>,
  old: readonly Item[],
  next: readonly Item[],
  style: Style | null,
): string {
  const whole = spanOf(base, seq);
  // A block item from its `-`.
  const items = seq.items.map((item) => {
    const span = spanOf(base, item);
    return seq.flow ? span : { ...span, start: block.lastIndexOf('-', span.start - 1) };
  });
  const [first, second] = items;
  const firstValue = seq.items[0] ? spanOf(base, seq.items[0]).start : 0;
  const marker = first && !seq.flow ? block.slice(first.start, firstValue) : '- ';
  const indent = block.slice(block.lastIndexOf('\n', whole.start - 1) + 1, whole.start);
  const lineBreak = block[block.indexOf('\n', whole.start) - 1] === '\r' ? '\r\n' : '\n';
  const separator =
    first && second ? block.slice(first.end, second.start) : seq.flow ? ', ' : lineBreak + indent;
  const fresh = (item: Item) =>
    seq.flow
      ? itemText(item, style, 'flow')
      : `${/^-[ ]+$/.test(marker) ? marker : '- '}${itemText(item, style, 'block')}`;
  const at = kept(old, next);
  const text = at
    .map((from, i) => {
      const item = items[from];
      const before = items[at[i - 1] ?? -1];
      const between =
        i === 0
          ? ''
          : item && before && from === (at[i - 1] ?? 0) + 1
            ? block.slice(before.end, item.start)
            : separator;
      return between + (item ? block.slice(item.start, item.end) : fresh(next[i] as Item));
    })
    .join('');
  if (!seq.flow) return text;
  const last = items.at(-1);
  const open = first ? block.slice(whole.start, first.start) : '[';
  const close = last ? block.slice(last.end, whole.end) : block.slice(whole.start + 1, whole.end);
  return open + text + close;
}

// For each of `next`'s items, the index of an old item equal to it, in
// order, or -1 for one written anew.
function kept(old: readonly Item[], next: readonly Item[]): number[] {
  let from = 0;
  return next.map((item) => {
    for (let i = from; i < old.length; i++) {
      if (sameValue(old[i] as PropertyValue, item as PropertyValue)) {
        from = i + 1;
        return i;
      }
    }
    return -1;
  });
}
