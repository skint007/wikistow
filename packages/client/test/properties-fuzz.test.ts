// Property edits on random blocks: whatever the keys, values, quoting,
// comments and line breaks, an edit changes nothing outside the value, key
// or lines it is about, the block still splits off the page as it did, it
// reads back as the old properties with only that change, and an editable
// value or a new key takes any value a property can hold.
import { describe, expect, it } from 'vite-plus/test';
import {
  propertyData,
  readProperties,
  removeProperty,
  renameProperty,
  setProperty,
  splitFrontmatter,
  type Property,
  type PropertyData,
  type PropertyEdit,
  type PropertyScalar,
  type PropertyValue,
} from '../src/index.ts';

/** mulberry32: the same seed, the same blocks. */
function random(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}
type Random = ReturnType<typeof random>;

// Keys as written, and as read.
const KEYS: [string, string][] = [
  ['title', 'title'],
  ['tags', 'tags'],
  ['cook_time', 'cook_time'],
  ['Cook Time', 'Cook Time'],
  ['COOK-TIME', 'COOK-TIME'],
  ['"quoted: key"', 'quoted: key'],
  ["'single'", 'single'],
  ['日本', '日本'],
  ['2024', '2024'],
  ['goes_with', 'goes_with'],
  ['notes', 'notes'],
  ['empty', 'empty'],
  ['&k anchored', 'anchored'],
  ['!!str tagged', 'tagged'],
];

// What follows a key's colon, read-only values too; `\n` is a line break.
const VALUES = [
  ' 1',
  ' -3.5',
  ' 0x1F',
  ' "35"',
  " 'it''s'",
  ' plain text',
  ' true',
  ' ~',
  '',
  '   ',
  ' # empty, with a note: here',
  ' 1 # a note',
  ' "[[Tomato soup]]"',
  " '[[Bread]]'",
  ' 2026-10-12',
  ' https://example.com/a?b=c',
  ' é 😀',
  ' "tab\\there"',
  ' [a, "b", \'c\']',
  ' [ soup ,winter ]',
  ' []',
  ' [p, q] # trailing',
  ' [[a, 1], b]',
  '\n  - recipe\n  - "bread"',
  '\n- flush\n- items',
  '\n  -   wide\n  -\n  - [x, y]',
  '\n  - a # inside\n  - b',
  '\n  - a\n  # inside\n  - b',
  ' |\n  literal\n  text',
  ' >-\n  folded\n  text',
  ' one\n  two',
  ' &anchor 5',
  ' !!str 5',
  ' {x: 1}',
  '\n  inner: 1',
  ' .inf',
  ' # before\n  value',
];

const BETWEEN = ['', '', '', '# a comment\n', '\n', '   # indented comment\n'];

// A block of random properties, all keys unique, and its line break.
function block(r: Random): { frontmatter: string; lineBreak: string } {
  const keys = [...KEYS].sort(() => r.next() - 0.5).slice(0, 1 + r.int(KEYS.length));
  const indent = r.int(6) === 0 ? '  ' : '';
  const lines = keys.map(([key]) => `${r.pick(BETWEEN)}${key}:${r.pick(VALUES)}\n`).join('');
  const content = (lines + r.pick(BETWEEN))
    .split('\n')
    .map((line) => (line === '' ? line : indent + line))
    .join('\n');
  const lineBreak = r.int(3) === 0 ? '\r\n' : '\n';
  const close = r.pick(['---', '...']) + r.pick([lineBreak, '']);
  return { frontmatter: `---\n${content}`.replace(/\n/g, lineBreak) + close, lineBreak };
}

const PIECES = [
  'a',
  'Tomato soup',
  '35',
  '-3',
  'true',
  'False',
  'null',
  '~',
  '',
  ' ',
  ':',
  ': ',
  '#',
  ' #',
  '-',
  '- ',
  '[',
  ']',
  '{',
  '}',
  ',',
  '"',
  "'",
  '\\',
  '\n',
  '\r\n',
  '\t',
  '&a',
  '*a',
  '!t',
  '%',
  '@',
  '`',
  '|',
  '>',
  '?',
  '---',
  '...',
  '[[Page]]',
  '[[A|b]]',
  '2026-10-12',
  'https://x.y/z',
  'é',
  '😀',
  '日本',
  '\u{2028}',
  '\u{feff}',
  '\u{85}',
  '\u{0}',
  '\u{7f}',
];

const NUMBERS = [0, 1, -1, 35, 4.5, -0.25, 1e21, 1.5e-7, Number.MAX_SAFE_INTEGER, 2 ** 70];

function scalar(r: Random): PropertyScalar {
  switch (r.int(8)) {
    case 0:
      return r.pick(NUMBERS);
    case 1:
      return r.next() < 0.5;
    case 2:
      return null;
    default:
      return Array.from({ length: r.int(4) }, () => r.pick(PIECES)).join('');
  }
}

function value(r: Random): PropertyValue {
  if (r.int(3) > 0) return scalar(r);
  return Array.from({ length: r.int(5) }, () =>
    r.int(5) === 0 ? Array.from({ length: r.int(3) }, () => scalar(r)) : scalar(r),
  );
}

// A list with one item added, removed or changed, so most are kept.
function changed(r: Random, list: readonly (PropertyScalar | readonly PropertyScalar[])[]) {
  const items = [...list];
  const at = r.int(items.length + 1);
  const op = r.int(3);
  if (op === 0 || items.length === 0) items.splice(at, 0, scalar(r));
  else if (op === 1) items.splice(Math.min(at, items.length - 1), 1);
  else items[Math.min(at, items.length - 1)] = scalar(r);
  return items;
}

function name(r: Random, taken: readonly string[]): string {
  for (;;) {
    const key = Array.from({ length: 1 + r.int(3) }, () => r.pick(PIECES)).join('');
    if (key !== '' && !taken.includes(key)) return key;
  }
}

const data = ({ key, type, value }: Property | PropertyData): PropertyData => ({
  key,
  type,
  value,
});

function edited(edit: PropertyEdit, what: string): string {
  if (!edit.ok) throw new Error(`${what}: ${edit.reason}`);
  return edit.frontmatter;
}

// Whether `after` is `before` with only the text from `start` to `end` changed.
const changedWithin = (before: string, after: string, start: number, end: number) =>
  after.length >= start + before.length - end &&
  after.startsWith(before.slice(0, start)) &&
  after.endsWith(before.slice(end));

// Whether the block still splits off a page as one block, itself.
const splits = (frontmatter: string) =>
  splitFrontmatter(`${frontmatter}${frontmatter.endsWith('\n') ? '' : '\n'}Body`).frontmatter ===
  frontmatter + (frontmatter.endsWith('\n') ? '' : '\n');

describe('property edits on random blocks', () => {
  it('change only what they are about, and read back as asked', () => {
    let editable = 0;
    let readOnly = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = random(seed);
      const { frontmatter: before, lineBreak } = block(r);
      const read = readProperties(before);
      if (!read.ok) continue;
      const all = read.properties;
      const keys = all.map((property) => property.key);
      const context = (what: string) => `seed ${seed}, ${what}: ${JSON.stringify(before)}`;

      for (const [i, property] of all.entries()) {
        const others = all.filter((_, j) => j !== i).map(data);

        // Set its value.
        const next =
          Array.isArray(property.value) && r.int(2) === 0 ? changed(r, property.value) : value(r);
        const set = setProperty(before, property.key, next);
        if (property.editable) {
          editable++;
          const after = edited(set, context(`set ${property.key} to ${JSON.stringify(next)}`));
          expect(changedWithin(before, after, property.keySpan.end, property.valueSpan.end)).toBe(
            true,
          );
          expect(splits(after)).toBe(true);
          const back = propertyData(after);
          expect(back[i]?.value, context('set')).toEqual(next);
          expect(back.filter((_, j) => j !== i)).toEqual(others);
        } else {
          readOnly++;
          // Unless it already has that value, when the block stays as it was.
          expect(set).toEqual(
            JSON.stringify(next) === JSON.stringify(property.value)
              ? { ok: true, frontmatter: before }
              : { ok: false, reason: expect.any(String) },
          );
        }

        // Rename it.
        const to = name(r, keys);
        const after = edited(renameProperty(before, property.key, to), context(`rename to ${to}`));
        expect(changedWithin(before, after, property.keySpan.start, property.keySpan.end)).toBe(
          true,
        );
        expect(splits(after)).toBe(true);
        expect(propertyData(after).map((p) => p.key)).toEqual(
          keys.map((key, j) => (j === i ? to : key)),
        );

        // Remove it: from its line's start, its lines and nothing else.
        const removed = edited(removeProperty(before, property.key), context('remove'));
        const lineStart = before.lastIndexOf('\n', property.keySpan.start - 1) + 1;
        const cut = before.length - removed.length;
        expect(removed).toBe(before.slice(0, lineStart) + before.slice(lineStart + cut));
        expect(lineStart + cut).toBeGreaterThanOrEqual(property.valueSpan.end);
        expect(splits(removed)).toBe(true);
        expect(propertyData(removed)).toEqual(others);
      }

      // Add a key, before the closing line.
      const key = name(r, keys);
      const added = value(r);
      const after = edited(setProperty(before, key, added), context(`add ${key}`));
      const closeStart = before.lastIndexOf('\n', before.length - 2) + 1;
      expect(changedWithin(before, after, closeStart, closeStart)).toBe(true);
      expect(after.slice(closeStart).endsWith(lineBreak + before.slice(closeStart))).toBe(true);
      expect(splits(after)).toBe(true);
      expect(propertyData(after)).toEqual([
        ...all.map(data),
        expect.objectContaining({ key, value: added }),
      ]);
    }
    // The blocks hold both kinds, plenty of each.
    expect(editable).toBeGreaterThan(500);
    expect(readOnly).toBeGreaterThan(200);
  });

  it('give a page with no block one that splits off it', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = random(seed);
      const key = name(r, []);
      const next = value(r);
      const lineBreak = r.pick(['\n', '\r\n'] as const);
      const frontmatter = edited(setProperty(null, key, next, lineBreak), `seed ${seed}`);
      expect(frontmatter.startsWith(`---${lineBreak}`)).toBe(true);
      expect(frontmatter.endsWith(`${lineBreak}---${lineBreak}`)).toBe(true);
      expect(splits(frontmatter)).toBe(true);
      expect(propertyData(frontmatter)).toEqual([expect.objectContaining({ key, value: next })]);
    }
  });
});
