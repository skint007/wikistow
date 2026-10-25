import { describe, expect, it } from 'vite-plus/test';
import {
  findProperty,
  foldPropertyName,
  isPropertyName,
  propertyData,
  propertyWikilink,
  readProperties,
  removeProperty,
  renameProperty,
  setProperty,
  splitFrontmatter,
  type Property,
  type PropertyEdit,
  type PropertyValue,
} from '../src/index.ts';

// A note as Obsidian writes one, with a few things people add by hand.
const OBSIDIAN = `---
title: Garlic bread
aliases:
  - Garlicky bread
tags:
  - recipe
  - "bread"
cook_time: 25 # minutes
Cook Time: "35"
servings: 4
vegetarian: true
created: 2026-10-12
updated: 2026-10-12T18:30
source: https://example.com/garlic-bread
goes_with: "[[Tomato soup]]"
rating: 4.5
cssclasses: []
notes: |
  Use fresh garlic.
---
`;

const crlf = (text: string) => text.replace(/\n/g, '\r\n');

function properties(frontmatter: string | null): Property[] {
  const read = readProperties(frontmatter);
  if (!read.ok) throw new Error(read.reason);
  return read.properties;
}

const byKey = (frontmatter: string, key: string) =>
  properties(frontmatter).find((property) => property.key === key);

function edited(edit: PropertyEdit): string {
  if (!edit.ok) throw new Error(edit.reason);
  return edit.frontmatter;
}

describe('reading properties', () => {
  it('reads each top-level key in order, typed by its value', () => {
    expect(
      properties(OBSIDIAN).map(({ key, type, value, editable }) => [key, type, value, editable]),
    ).toEqual([
      ['title', 'text', 'Garlic bread', true],
      ['aliases', 'list', ['Garlicky bread'], true],
      ['tags', 'list', ['recipe', 'bread'], true],
      ['cook_time', 'number', 25, true],
      ['Cook Time', 'text', '35', true],
      ['servings', 'number', 4, true],
      ['vegetarian', 'boolean', true, true],
      ['created', 'date', '2026-10-12', true],
      ['updated', 'date', '2026-10-12T18:30', true],
      ['source', 'url', 'https://example.com/garlic-bread', true],
      ['goes_with', 'wikilink', '[[Tomato soup]]', true],
      ['rating', 'number', 4.5, true],
      ['cssclasses', 'list', [], true],
      ['notes', 'text', 'Use fresh garlic.\n', false],
    ]);
  });

  it('places each key and value in the block, delimiters included, whatever the line breaks', () => {
    for (const block of [OBSIDIAN, crlf(OBSIDIAN)]) {
      const sources = properties(block).map(({ keySpan, valueSpan }) => [
        block.slice(keySpan.start, keySpan.end),
        block.slice(valueSpan.start, valueSpan.end),
      ]);
      expect(sources.slice(0, 5)).toEqual([
        ['title', 'Garlic bread'],
        ['aliases', '- Garlicky bread'],
        ['tags', block.includes('\r') ? '- recipe\r\n  - "bread"' : '- recipe\n  - "bread"'],
        ['cook_time', '25'],
        ['"Cook Time"'.slice(1, -1), '"35"'],
      ]);
    }
    const block = '---\nempty:\nnext: 1\n---\n';
    const empty = byKey(block, 'empty');
    expect(empty).toMatchObject({ type: 'text', value: null, editable: true });
    expect(empty?.valueSpan).toEqual({ start: 10, end: 10 });
  });

  it('has none for no block, an empty one, or one of comments', () => {
    for (const block of [
      null,
      '---\n---\n',
      '---\n...\n',
      '---\n# just a note\n\n---',
      '---\r\n---',
    ]) {
      expect(readProperties(block)).toEqual({ ok: true, properties: [] });
    }
  });

  it('says why a block that isn’t keys and values has none', () => {
    expect(readProperties('---\n- a\n- b\n---\n')).toEqual({
      ok: false,
      reason: 'It holds a list, not keys and values.',
    });
    expect(readProperties('---\njust some words\n---\n')).toEqual({
      ok: false,
      reason: 'It holds one value, not keys and values.',
    });
    // Lines count from the opening delimiter, as an editor numbers them.
    expect(readProperties('---\na: 1\nb: 2\na: 3\n---\n')).toEqual({
      ok: false,
      reason: 'Map keys must be unique (line 4).',
    });
    // A complaint quoting the source is cut short.
    const tagged = readProperties(`---\na: !!${'!'.repeat(60_000)} x\n---\n`);
    expect(!tagged.ok && tagged.reason.length).toBeLessThan(200);
    const broken = readProperties('---\ntags: [a, b\ntitle: x\n---\n');
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.reason).toMatch(/\(line \d+\)\.$/);
    expect(readProperties('---\n? [a, b]\n: 1\n---\n')).toEqual({
      ok: false,
      reason: 'A key isn’t plain text.',
    });
  });

  it('types values by what they read as', () => {
    const block = `---
hex: 0x1F
negative: -3
exponent: 1e3
quoted_number: "35"
capital: True
quoted_true: 'true'
nothing: null
tilde: ~
not_a_day: 2026-02-30
leap_day: 2024-02-29
with_seconds: 2026-10-12 18:30:05
with_zone: 2026-10-12T18:30:05.25+02:00
spaced_zone: 2026-10-12 10:00 +01:00
not_a_time: 2026-10-12T25:00
ftp: ftp://example.com
bare: example.com
spaced: https://example.com/a b
link_text: "[[Page|shown]]"
link_heading: "[[Page#Part]]"
two_links: "[[A]] and [[B]]"
embed: "![[photo.png]]"
block_ref: "[[Page#^abc]]"
unquoted_link: [[Page]]
nested: [[a, b], c]
infinite: .inf
---
`;
    expect(properties(block).map(({ key, type, value }) => [key, type, value])).toEqual([
      ['hex', 'number', 31],
      ['negative', 'number', -3],
      ['exponent', 'number', 1000],
      ['quoted_number', 'text', '35'],
      ['capital', 'boolean', true],
      ['quoted_true', 'text', 'true'],
      ['nothing', 'text', null],
      ['tilde', 'text', null],
      ['not_a_day', 'text', '2026-02-30'],
      ['leap_day', 'date', '2024-02-29'],
      ['with_seconds', 'date', '2026-10-12 18:30:05'],
      ['with_zone', 'date', '2026-10-12T18:30:05.25+02:00'],
      ['spaced_zone', 'date', '2026-10-12 10:00 +01:00'],
      ['not_a_time', 'text', '2026-10-12T25:00'],
      ['ftp', 'text', 'ftp://example.com'],
      ['bare', 'text', 'example.com'],
      ['spaced', 'text', 'https://example.com/a b'],
      ['link_text', 'wikilink', '[[Page|shown]]'],
      ['link_heading', 'wikilink', '[[Page#Part]]'],
      ['two_links', 'text', '[[A]] and [[B]]'],
      ['embed', 'text', '![[photo.png]]'],
      ['block_ref', 'text', '[[Page#^abc]]'],
      // Unquoted, YAML reads it as a list holding a list.
      ['unquoted_link', 'list', [['Page']]],
      ['nested', 'list', [['a', 'b'], 'c']],
      // Not JSON, so its source; one line, so it can be replaced.
      ['infinite', 'text', '.inf'],
    ]);
    expect(byKey(block, 'infinite')?.editable).toBe(true);
    expect(edited(setProperty(block, 'infinite', 2))).toContain('\ninfinite: 2\n');
  });

  it('keeps a value editable with a comment after it, not one with a comment inside', () => {
    const block = `---
scalar: 1 # after
flow: [a, b] # after
inside_flow: [a, # inside
  b]
between_items:
  - a
  # inside
  - b
after_item:
  - a # inside
  - b
after_key: # before the value
  value
---
`;
    expect(properties(block).map(({ key, editable }) => [key, editable])).toEqual([
      ['scalar', true],
      ['flow', true],
      ['inside_flow', false],
      ['between_items', false],
      ['after_item', false],
      ['after_key', false],
    ]);
  });

  it('reads values it can’t change in place, read-only', () => {
    const block = `---
plain_lines: one
  two
quoted_lines: "one
  two"
literal: |
  one
folded: >
  one
anchored: &shared 5
alias: *shared
tagged: !!str 5
map:
  inner: 1
flow_map: {inner: 1}
list_of_maps:
  - name: a
deep: [[[a]]]
block_in_block:
  - - a
    - b
flow_lines: [a,
  b]
---
`;
    expect(
      properties(block).map(({ key, type, value, editable }) => [key, type, value, editable]),
    ).toEqual([
      ['plain_lines', 'text', 'one two', false],
      ['quoted_lines', 'text', 'one two', false],
      ['literal', 'text', 'one\n', false],
      ['folded', 'text', 'one\n', false],
      ['anchored', 'number', 5, false],
      // An alias isn't followed: it shows as written.
      ['alias', 'text', '*shared', false],
      ['tagged', 'text', '5', false],
      // Anything else shows its source.
      ['map', 'text', 'inner: 1', false],
      ['flow_map', 'text', '{inner: 1}', false],
      ['list_of_maps', 'text', '- name: a', false],
      ['deep', 'text', '[[[a]]]', false],
      ['block_in_block', 'list', [['a', 'b']], false],
      ['flow_lines', 'list', ['a', 'b'], false],
    ]);
  });

  it(
    'reads aliases in time to the block’s size, however many name a long list',
    { retry: 2 },
    () => {
      const items = Array.from({ length: 8_000 }, () => '1').join(', ');
      const aliases = Array.from({ length: 8_000 }, () => '*a').join(', ');
      const block = `---\na: &a [${items}]\nb: [${aliases}]\n---\n`;
      const started = performance.now();
      const [, b] = properties(block);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(b).toMatchObject({ type: 'text', editable: false });
      expect(b?.value).toHaveLength(aliases.length + 2);
    },
  );

  it(
    'reads the longest block it takes in time to its size, and no longer one',
    { retry: 2 },
    () => {
      const lines = (count: number, line: (i: number) => string) =>
        Array.from({ length: count }, (_, i) => line(i)).join('\n');
      const blocks = [
        // Many keys, at the top and in a map of their own.
        `---\n${lines(6_500, (i) => `k${i}: 1`)}\n---\n`,
        `---\nm:\n${lines(5_500, (i) => `  k${i}: 1`)}\n---\n`,
        // A line of complaints.
        `---\na: [${'x, ,'.repeat(15_000)}]\n---\n`,
        // Long runs of blanks inside a value, a map and a list.
        `---\nk: a${' '.repeat(60_000)}b\n---\n`,
        `---\nk:\n  a: 1\n${'\n'.repeat(60_000)}  b: 2\n---\n`,
        `---\nk:\n  - a\n${'\n'.repeat(60_000)}  - b\n---\n`,
        // Comment lines after an empty node, which the parser has it take in.
        `---\nk:\n  x:\n${'#\n'.repeat(30_000)}b: 1\n---\n`,
      ];
      for (const block of blocks) {
        expect(block.length).toBeLessThan(65_536);
        const started = performance.now();
        readProperties(block);
        setProperty(block, 'new', 1);
        expect(performance.now() - started).toBeLessThan(2_000);
      }
      expect(readProperties(`---\na: "${'x'.repeat(65_536)}"\n---\n`)).toEqual({
        ok: false,
        reason: 'It is too long to read as properties.',
      });
    },
  );

  it('refuses an edit that would make the block too long, saying so', () => {
    // At the limit, `*big` fits only plain, where it would read as an alias.
    const head = 'a: &big [1, 2, 3]\nb: old\n# ';
    const yaml = `${head}${'x'.repeat(65_535 - head.length - 1)}\n`;
    expect(yaml.length).toBe(65_535);
    const block = `---\n${yaml}---\n`;
    expect(byKey(block, 'b')?.value).toBe('old');
    const tooLong = { ok: false, reason: 'It would be too long to read as properties.' };
    expect(setProperty(block, 'b', '*big')).toEqual(tooLong);
    expect(setProperty(block, 'b', '{x: 1}')).toEqual(tooLong);
    expect(setProperty(block, 'b', 'longer')).toEqual(tooLong);
    expect(edited(setProperty(block, 'b', 'new'))).toContain('\nb: new\n');
  });

  it('refuses keys twice in any map, and an alias without its anchor', () => {
    expect(readProperties('---\nm:\n  x: 1\n  x: 2\n---\n')).toEqual({
      ok: false,
      reason: 'Map keys must be unique (line 4).',
    });
    expect(readProperties('---\nm: {x: 1, x: 2}\n---\n')).toMatchObject({ ok: false });
    // A number and a string differ to YAML, but are the same key as written.
    expect(readProperties('---\n1: a\n"1": b\n---\n')).toEqual({
      ok: false,
      reason: 'Map keys must be unique (line 3).',
    });
    expect(readProperties('---\ntrue: a\n"true": b\n---\n')).toMatchObject({ ok: false });
    // Or the same key to a reader's object.
    for (const [a, b] of [
      ['0x1F', '"31"'],
      ['1.0', '"1"'],
      ['1e3', '1000'],
      ['~', '""'],
    ]) {
      expect(readProperties(`---\n${a}: x\n${b}: y\n---\n`), `${a} ${b}`).toMatchObject({
        ok: false,
      });
    }
    expect(readProperties('---\na: *x\nb: &x 1\n---\n')).toEqual({
      ok: false,
      reason: 'An alias names no anchor before it (line 2).',
    });
  });

  it('reads an integer longer than a number holds exactly as its source', () => {
    const block =
      '---\nid: 12345678901234567890\nbig: 9007199254740993\nsafe: 9007199254740991\n---\n';
    expect(
      properties(block).map(({ key, type, value, editable }) => [key, type, value, editable]),
    ).toEqual([
      ['id', 'text', '12345678901234567890', true],
      ['big', 'text', '9007199254740993', true],
      ['safe', 'number', 9007199254740991, true],
    ]);
    // Such a number is written so that it reads back as itself.
    const result = edited(setProperty(block, 'safe', 2 ** 60));
    expect(result).toContain('\nsafe: 1.152921504606847e+18\n');
    expect(byKey(result, 'safe')?.value).toBe(2 ** 60);
  });

  it('shows a value’s source from its anchor or tag', () => {
    const block = '---\nmeta: &m\n  x: 1\ntagged: !t {x: 1}\nshared: &s 5\n---\n';
    const read = properties(block);
    expect(read.map(({ key, value }) => [key, value])).toEqual([
      ['meta', '&m\n  x: 1'],
      ['tagged', '!t {x: 1}'],
      ['shared', 5],
    ]);
    expect(read.map(({ valueSpan }) => block.slice(valueSpan.start, valueSpan.end))).toEqual([
      '&m\n  x: 1',
      '!t {x: 1}',
      '&s 5',
    ]);
  });

  it('reads a top-level flow map, without editing it in place', () => {
    const block = '---\n{a: 1, b: [x]}\n---\n';
    expect(properties(block).map(({ key, value, editable }) => [key, value, editable])).toEqual([
      ['a', 1, false],
      ['b', ['x'], false],
    ]);
    expect(setProperty(block, 'a', 2)).toMatchObject({ ok: false });
    expect(setProperty(block, 'c', 2)).toMatchObject({ ok: false });
  });

  it('reads keys as written: odd case, quoted, a number, keys alike once folded', () => {
    const block = `---
cook_time: 1
Cook Time: 2
COOK-TIME: 3
"quoted key": 4
2024: 5
日本: 6
---
`;
    expect(properties(block).map(({ key }) => key)).toEqual([
      'cook_time',
      'Cook Time',
      'COOK-TIME',
      'quoted key',
      '2024',
      '日本',
    ]);
  });

  it('has no block for a page with a byte-order mark before its delimiter', () => {
    // The splitter reads `---` only at the very start, so the mark makes it body.
    expect(splitFrontmatter('\u{feff}---\na: 1\n---\nBody').frontmatter).toBeNull();
  });

  it('gives plain data for an index to keep', () => {
    const data = propertyData(OBSIDIAN);
    expect(data[1]).toEqual({ key: 'aliases', type: 'list', value: ['Garlicky bread'] });
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(propertyData('---\n- a\n---\n')).toEqual([]);
    expect(propertyData(null)).toEqual([]);
  });
});

describe('setting a value', () => {
  it('changes only the value’s characters', () => {
    const block = crlf('---\n# Recipe\ncook_time: 25 # minutes\nservings: 4\n---\n');
    expect(edited(setProperty(block, 'cook_time', 30))).toBe(
      crlf('---\n# Recipe\ncook_time: 30 # minutes\nservings: 4\n---\n'),
    );
  });

  it('keeps a string’s quoting where it can hold the value', () => {
    const block = `---\nplain: a\ndouble: "a"\nsingle: 'a'\n---\n`;
    expect(edited(setProperty(block, 'plain', 'Tomato soup'))).toContain('plain: Tomato soup\n');
    expect(edited(setProperty(block, 'double', 'b'))).toContain('double: "b"\n');
    expect(edited(setProperty(block, 'single', 'it’s Sam’s'))).toContain("single: 'it’s Sam’s'\n");
    expect(edited(setProperty(block, 'single', "Sam's"))).toContain("single: 'Sam''s'\n");
    // A line break can't be in single quotes, so it's escaped in double ones.
    expect(edited(setProperty(block, 'single', 'one\ntwo'))).toContain('single: "one\\u000atwo"\n');
  });

  it('quotes plain text that would read as something else', () => {
    const block = '---\nname: Sam\nnext: 1\n---\n';
    const cases: [string, string][] = [
      ['35', '"35"'],
      ['true', '"true"'],
      ['null', '"null"'],
      ['', '""'],
      ['a: b', '"a: b"'],
      ['#tag', '"#tag"'],
      ['- item', '"- item"'],
      [' spaced ', '" spaced "'],
      ['[[Garlic bread]]', '"[[Garlic bread]]"'],
      ['say "hi"', 'say "hi"'],
      ['\\', '\\'],
      ['tab\there', '"tab\\u0009here"'],
      ['\u{2028}', '"\\u2028"'],
      ['😀 é 日本', '😀 é 日本'],
    ];
    for (const [value, written] of cases) {
      const result = edited(setProperty(block, 'name', value));
      expect(result).toBe(`---\nname: ${written}\nnext: 1\n---\n`);
      expect(byKey(result, 'name')?.value).toBe(value);
    }
  });

  it('changes a type by how the value is written', () => {
    const block = '---\nn: 35\nq: "35"\nb: true\n---\n';
    expect(edited(setProperty(block, 'n', '35'))).toContain('n: "35"\n');
    expect(edited(setProperty(block, 'q', 35))).toContain('q: 35\n');
    expect(edited(setProperty(block, 'b', 'true'))).toContain('b: "true"\n');
    expect(edited(setProperty(block, 'n', false))).toContain('n: false\n');
    expect(edited(setProperty(block, 'n', ['35']))).toContain('n: ["35"]\n');
    expect(byKey(edited(setProperty(block, 'n', '35')), 'n')?.type).toBe('text');
  });

  it('fills an empty value, and empties one', () => {
    const block = '---\nempty:\nfull: 1 # note\ntags:\n  - a\n---\n';
    expect(edited(setProperty(block, 'empty', 'x'))).toBe(
      '---\nempty: x\nfull: 1 # note\ntags:\n  - a\n---\n',
    );
    expect(edited(setProperty(block, 'full', null))).toBe(
      '---\nempty:\nfull: # note\ntags:\n  - a\n---\n',
    );
    expect(edited(setProperty(block, 'tags', null))).toBe(
      '---\nempty:\nfull: 1 # note\ntags:\n---\n',
    );
  });

  it('fills an empty value before a comment after it', () => {
    const block = '---\nstatus: # workflow\nnext: 1\n---\n';
    expect(byKey(block, 'status')).toMatchObject({
      editable: true,
      valueSpan: { start: 11, end: 11 },
    });
    expect(edited(setProperty(block, 'status', 'done'))).toBe(
      '---\nstatus: done # workflow\nnext: 1\n---\n',
    );
    const cleared = edited(setProperty('---\nstatus: draft # workflow\n---\n', 'status', null));
    expect(edited(setProperty(cleared, 'status', ['a']))).toBe(
      '---\nstatus: [a] # workflow\n---\n',
    );
    // An explicit key's colon is the one after its comment.
    expect(edited(setProperty('---\n? a # x: y\n:\nb: 1\n---\n', 'a', 5))).toBe(
      '---\n? a # x: y\n: 5\nb: 1\n---\n',
    );
  });

  it('sets a value shown as its source to that text only as text', () => {
    expect(setProperty('---\nm: {x: 1}\n---\n', 'm', '{x: 1}')).toMatchObject({ ok: false });
    expect(setProperty('---\nm: *a\n---\n', 'm', '*a')).toMatchObject({ ok: false });
    expect(edited(setProperty('---\nn: .inf\n---\n', 'n', '.inf'))).toBe('---\nn: ".inf"\n---\n');
  });

  it('empties a value as null where nothing at all wouldn’t read', () => {
    // YAML takes a tab-only line after `a: 1`, but not after `a:`.
    expect(edited(setProperty('---\na: 1\n\t\nb: 2\n---\n', 'a', null))).toBe(
      '---\na: null\n\t\nb: 2\n---\n',
    );
  });

  it('edits a value ending in a space that isn’t YAML’s, keeping it its own', () => {
    const block = '---\na: pasted\u{a0}\nb: こんにちは\u{3000}\n---\n';
    expect(byKey(block, 'a')?.value).toBe('pasted\u{a0}');
    expect(edited(setProperty(block, 'a', 'x'))).toBe('---\na: x\nb: こんにちは\u{3000}\n---\n');
    expect(edited(setProperty(block, 'b', ['x']))).toBe('---\na: pasted\u{a0}\nb: [x]\n---\n');
  });

  it('returns the block as it was for the value it already has', () => {
    const block = '---\nn: 0x23\nnotes: |\n  text\n---\n';
    expect(setProperty(block, 'n', 35)).toEqual({ ok: true, frontmatter: block });
    expect(setProperty(block, 'notes', 'text\n')).toEqual({ ok: true, frontmatter: block });
  });

  it('edits a flow list keeping its items, brackets and separators as written', () => {
    const block = `---\ntags: [ soup, "winter",  'easy' ] # mine\n---\n`;
    expect(edited(setProperty(block, 'tags', ['soup', 'winter', 'easy', 'quick']))).toBe(
      `---\ntags: [ soup, "winter",  'easy', quick ] # mine\n---\n`,
    );
    expect(edited(setProperty(block, 'tags', ['soup', 'easy']))).toBe(
      `---\ntags: [ soup, 'easy' ] # mine\n---\n`,
    );
    expect(edited(setProperty(block, 'tags', []))).toBe(`---\ntags: [  ] # mine\n---\n`);
    // An item that can't be plain in a flow list is quoted.
    expect(edited(setProperty(block, 'tags', ['a, b']))).toBe(
      `---\ntags: [ "a, b" ] # mine\n---\n`,
    );
  });

  it('writes new string items quoted as the list’s first string item is', () => {
    const block = `---\nlinks: ["[[A]]"]\nsingle:\n  - 'a'\n---\n`;
    expect(edited(setProperty(block, 'links', ['[[A]]', 'b']))).toContain(
      'links: ["[[A]]", "b"]\n',
    );
    expect(edited(setProperty(block, 'single', ['a', 'b']))).toContain(
      "single:\n  - 'a'\n  - 'b'\n",
    );
  });

  it('edits a block list in its indentation, marker and line breaks', () => {
    const block = crlf('---\ntags:\n  -   recipe\n  - "bread"\nnext: 1\n---\n');
    expect(edited(setProperty(block, 'tags', ['recipe', 'bread', 'quick']))).toBe(
      crlf('---\ntags:\n  -   recipe\n  - "bread"\n  -   quick\nnext: 1\n---\n'),
    );
    expect(edited(setProperty(block, 'tags', ['bread']))).toBe(
      crlf('---\ntags:\n  - "bread"\nnext: 1\n---\n'),
    );
    expect(edited(setProperty(block, 'tags', []))).toBe(crlf('---\ntags: []\nnext: 1\n---\n'));
    expect(edited(setProperty(block, 'tags', 'soup'))).toBe(
      crlf('---\ntags: soup\nnext: 1\n---\n'),
    );
    const flush = '---\ntags:\n- a\n- b\n---\n';
    expect(edited(setProperty(flush, 'tags', ['a', 'c', 'b']))).toBe(
      '---\ntags:\n- a\n- c\n- b\n---\n',
    );
  });

  it('writes a list as a flow list where there was none, lists of lists too', () => {
    const block = '---\ntags: soup\n---\n';
    expect(edited(setProperty(block, 'tags', ['soup', 'winter']))).toBe(
      '---\ntags: [soup, winter]\n---\n',
    );
    expect(edited(setProperty(block, 'tags', [['a', 1], true, null, '35']))).toBe(
      '---\ntags: [[a, 1], true, null, "35"]\n---\n',
    );
    const nested = '---\npairs:\n  - [a, 1]\n---\n';
    expect(
      edited(
        setProperty(nested, 'pairs', [
          ['a', 1],
          ['b', 2],
        ]),
      ),
    ).toBe('---\npairs:\n  - [a, 1]\n  - [b, 2]\n---\n');
  });

  it('rewrites a wikilink value in its quotes', () => {
    const block = `---\ngoes_with: "[[Tomato soup]]"\nalso: '[[Bread]]'\n---\n`;
    const result = edited(setProperty(block, 'goes_with', '[[Tomato bisque]]'));
    expect(result).toBe(`---\ngoes_with: "[[Tomato bisque]]"\nalso: '[[Bread]]'\n---\n`);
    expect(edited(setProperty(block, 'also', '[[Rolls]]'))).toContain(`also: '[[Rolls]]'\n`);
  });

  it('matches the key exactly as written', () => {
    const block = '---\ncook_time: 1\nCook Time: 2\n---\n';
    expect(edited(setProperty(block, 'Cook Time', 3))).toBe(
      '---\ncook_time: 1\nCook Time: 3\n---\n',
    );
    expect(edited(setProperty(block, 'cook time', 4))).toBe(
      '---\ncook_time: 1\nCook Time: 2\ncook time: 4\n---\n',
    );
  });

  it('refuses a value it can’t change in place, saying why', () => {
    const block = `---
lines: one
  two
literal: |
  one
anchor: &a 1
alias: *a
tagged: !!str 1
comment:
  - a
  # c
  - b
map:
  x: 1
---
`;
    const reasons = Object.fromEntries(
      ['lines', 'literal', 'anchor', 'alias', 'tagged', 'comment', 'map'].map((key) => [
        key,
        setProperty(block, key, 'new'),
      ]),
    );
    expect(reasons).toEqual({
      lines: { ok: false, reason: 'It is on more than one line.' },
      literal: { ok: false, reason: 'It is a block of lines.' },
      anchor: { ok: false, reason: 'It has an anchor.' },
      alias: { ok: false, reason: 'It is an alias of another value.' },
      tagged: { ok: false, reason: 'It has a YAML tag.' },
      comment: { ok: false, reason: 'It has a comment inside it.' },
      map: { ok: false, reason: 'It holds keys and values of its own.' },
    });
  });

  it('refuses what a property can’t hold, and a block that doesn’t read', () => {
    const block = '---\na: 1\n---\n';
    for (const value of [Number.NaN, Infinity, [[['deep']]], { a: 1 }, undefined]) {
      expect(setProperty(block, 'a', value as unknown as PropertyValue)).toMatchObject({
        ok: false,
      });
    }
    expect(setProperty('---\na: [\n---\n', 'a', 1)).toMatchObject({ ok: false });
    expect(setProperty('---\n- a\n---\n', 'b', 1)).toEqual({
      ok: false,
      reason: 'It holds a list, not keys and values.',
    });
  });
});

describe('adding a key', () => {
  it('adds a line at the block’s end, in its indentation and line breaks', () => {
    expect(edited(setProperty(crlf('---\na: 1\n# end\n---\n'), 'b', 'x'))).toBe(
      crlf('---\na: 1\n# end\nb: x\n---\n'),
    );
    expect(edited(setProperty('---\n  a: 1\n---\n', 'b', 2))).toBe('---\n  a: 1\n  b: 2\n---\n');
    expect(edited(setProperty('---\n?\n  a\n: 1\n---\n', 'b', 2))).toBe(
      '---\n?\n  a\n: 1\nb: 2\n---\n',
    );
    expect(edited(setProperty('---\n  !!str a: 1\n---\n', 'b', 2))).toBe(
      '---\n  !!str a: 1\n  b: 2\n---\n',
    );
    expect(edited(setProperty('---\na: 1\n...', 'b', true))).toBe('---\na: 1\nb: true\n...');
    expect(edited(setProperty('---\nnotes: |\n  text\n---\n', 'b', ['x']))).toBe(
      '---\nnotes: |\n  text\nb: [x]\n---\n',
    );
    expect(edited(setProperty('---\n---\n', 'tags', []))).toBe('---\ntags: []\n---\n');
    expect(edited(setProperty('---\n---\n', 'empty', null))).toBe('---\nempty:\n---\n');
  });

  it('quotes a key or value that needs it', () => {
    expect(edited(setProperty('---\n---\n', 'a: b', '[[Page]]'))).toBe(
      '---\n"a: b": "[[Page]]"\n---\n',
    );
    expect(edited(setProperty('---\n---\n', 'Cook Time', '35'))).toBe(
      '---\nCook Time: "35"\n---\n',
    );
  });

  it('quotes a new key that would read as a number, null or true', () => {
    for (const key of ['0x10', '1e3', '~', 'null', 'true', '35', '<<', '---', '...x']) {
      const result = edited(setProperty('---\n---\n', key, 'v'));
      expect(result).toBe(`---\n"${key}": v\n---\n`);
      expect(edited(renameProperty('---\na: v\n---\n', 'a', key))).toBe(result);
    }
  });

  it('makes a block for a page with none', () => {
    expect(edited(setProperty(null, 'status', 'draft'))).toBe('---\nstatus: draft\n---\n');
    expect(edited(setProperty(null, 'status', 'draft', '\r\n'))).toBe(
      '---\r\nstatus: draft\r\n---\r\n',
    );
    expect(splitFrontmatter(`${edited(setProperty(null, 'a', 1))}# Body\n`)).toEqual({
      frontmatter: '---\na: 1\n---\n',
      body: '# Body\n',
    });
  });

  it('refuses a key with no name', () => {
    expect(setProperty('---\n---\n', '', 1)).toEqual({
      ok: false,
      reason: 'A property needs a name.',
    });
  });
});

describe('renaming a key', () => {
  it('changes only the key’s characters, in its quoting', () => {
    const block = crlf(`---\ncook_time: 25 # minutes\n"Serves": 4\n---\n`);
    expect(edited(renameProperty(block, 'cook_time', 'Cook time'))).toBe(
      crlf(`---\nCook time: 25 # minutes\n"Serves": 4\n---\n`),
    );
    expect(edited(renameProperty(block, 'Serves', 'servings'))).toBe(
      crlf(`---\ncook_time: 25 # minutes\n"servings": 4\n---\n`),
    );
    expect(edited(renameProperty(block, 'cook_time', 'time: total'))).toBe(
      crlf(`---\n"time: total": 25 # minutes\n"Serves": 4\n---\n`),
    );
  });

  it('refuses to rename a key with an anchor, which aliases name', () => {
    expect(renameProperty('---\n&k a: 1\nb: [*k]\n---\n', 'a', 'z')).toEqual({
      ok: false,
      reason: 'The key has an anchor.',
    });
  });

  it('renames a key whose value is read-only', () => {
    const block = '---\nnotes: |\n  text\n---\n';
    expect(edited(renameProperty(block, 'notes', 'Notes'))).toBe('---\nNotes: |\n  text\n---\n');
  });

  it('refuses a missing key, a name in use, or no name', () => {
    const block = '---\ncook_time: 1\nCook Time: 2\n---\n';
    expect(renameProperty(block, 'cook', 'x')).toEqual({
      ok: false,
      reason: 'There is no property cook.',
    });
    expect(renameProperty(block, 'cook_time', 'Cook Time')).toEqual({
      ok: false,
      reason: 'There is already a property Cook Time.',
    });
    expect(renameProperty(block, 'cook_time', '')).toMatchObject({ ok: false });
    // Nor one that a reader's object would have as another key.
    expect(renameProperty('---\n0x1F: a\nx: b\n---\n', 'x', '31')).toEqual({
      ok: false,
      reason: 'There is already a property 0x1F.',
    });
    expect(setProperty('---\n1.0: a\n---\n', '1', 'b')).toEqual({
      ok: false,
      reason: 'There is already a property 1.0.',
    });
    // Alike once folded is allowed: the first in the block still wins.
    expect(edited(renameProperty(block, 'cook_time', 'COOK_TIME'))).toBe(
      '---\nCOOK_TIME: 1\nCook Time: 2\n---\n',
    );
  });
});

describe('removing a key', () => {
  it('removes its lines and nothing else', () => {
    const block = crlf(`---
# Recipe
cook_time: 25 # minutes
tags:
  - a
  - b
# about notes
notes: |
  text

last: 1
---
`);
    expect(edited(removeProperty(block, 'cook_time'))).toBe(
      crlf('---\n# Recipe\ntags:\n  - a\n  - b\n# about notes\nnotes: |\n  text\n\nlast: 1\n---\n'),
    );
    expect(edited(removeProperty(block, 'tags'))).toBe(
      crlf(
        '---\n# Recipe\ncook_time: 25 # minutes\n# about notes\nnotes: |\n  text\n\nlast: 1\n---\n',
      ),
    );
    expect(edited(removeProperty(block, 'notes'))).toBe(
      // The blank line after the block of text is the author's, not its.
      crlf(
        '---\n# Recipe\ncook_time: 25 # minutes\ntags:\n  - a\n  - b\n# about notes\n\nlast: 1\n---\n',
      ),
    );
  });

  it('removes a list with its comments, and the last key to an empty block', () => {
    expect(
      edited(removeProperty('---\ntags:\n  - a\n  # inside\n  - b\nc: 1\n---\n', 'tags')),
    ).toBe('---\nc: 1\n---\n');
    expect(edited(removeProperty('---\na:\n---', 'a'))).toBe('---\n---');
  });

  it('removes the comment lines indented under a key with it', () => {
    expect(edited(removeProperty('---\na: 1\nb: 2\n  # under b\nc: 3\n---\n', 'b'))).toBe(
      '---\na: 1\nc: 3\n---\n',
    );
    // Not one at the key's own indentation, which is the next key's.
    expect(edited(removeProperty('---\na: 1\nb: 2\n# about c\nc: 3\n---\n', 'b'))).toBe(
      '---\na: 1\n# about c\nc: 3\n---\n',
    );
  });

  it('removes a key after a `?`, an anchor or a tag on its line', () => {
    expect(edited(removeProperty('---\n? a\n: 1\nb: 2\n---\n', 'a'))).toBe('---\nb: 2\n---\n');
    expect(edited(removeProperty('---\n&k a: 1\nb: 2\n---\n', 'a'))).toBe('---\nb: 2\n---\n');
    expect(edited(removeProperty('---\n!!str a: 1\nb: 2\n---\n', 'a'))).toBe('---\nb: 2\n---\n');
  });

  it('keeps the comments after a value that ends empty', () => {
    const list = '---\ntags:\n  - a\n  -\n# about b\nb: 1\n---\n';
    expect(edited(removeProperty(list, 'tags'))).toBe('---\n# about b\nb: 1\n---\n');
    const map = '---\nauthor:\n  name: Ann\n  url:\n\n# Publishing\nstatus: draft\n---\n';
    expect(edited(removeProperty(map, 'author'))).toBe('---\n\n# Publishing\nstatus: draft\n---\n');
    expect(byKey(map, 'author')?.value).toBe('name: Ann\n  url:');
  });

  it('refuses to remove an anchor while aliases may name it', () => {
    for (const block of [
      '---\na: &x 1\nb: *x\n---\n',
      '---\na: &x 1\nc: &x 2\nb: *x\n---\n',
      '---\nm: {k: &x [1, 2]}\nb: [*x]\n---\n',
      '---\n&x a: 1\nb: *x\n---\n',
    ]) {
      const key = properties(block)[block.includes('c: &x') ? 1 : 0]?.key ?? '';
      expect(removeProperty(block, key)).toEqual({
        ok: false,
        reason: 'It holds an anchor, which aliases may name.',
      });
    }
    expect(edited(removeProperty('---\na: &x 1\nb: *x\nc: 2\n---\n', 'c'))).toBe(
      '---\na: &x 1\nb: *x\n---\n',
    );
  });

  it('refuses a missing key', () => {
    expect(removeProperty('---\na: 1\n---\n', 'b')).toEqual({
      ok: false,
      reason: 'There is no property b.',
    });
  });
});

describe('property names', () => {
  it('follow the template-variable rule', () => {
    for (const name of ['servings', 'cook time', 'cook_time', 'Cook-Time', '2024', '日本', 'é']) {
      expect(isPropertyName(name), name).toBe(true);
    }
    for (const name of [
      '',
      ' servings',
      '_private',
      'SUM(A1:A3)',
      'a.b',
      'this.servings',
      '#tag',
    ]) {
      expect(isPropertyName(name), name).toBe(false);
    }
  });

  it('match keys whatever their case, with _, - and spaces alike', () => {
    expect(foldPropertyName('Cook_Time')).toBe(foldPropertyName('cook-time'));
    expect(foldPropertyName('Cook_Time')).toBe(foldPropertyName('COOK TIME'));
    expect(foldPropertyName('cooktime')).not.toBe(foldPropertyName('cook time'));
    const read = properties('---\ntitle: x\ncook_time: 1\nCook Time: 2\n---\n');
    expect(findProperty(read, 'cook time')?.value).toBe(1);
    expect(findProperty(read, 'COOK-TIME')?.value).toBe(1);
    expect(findProperty(read, 'Cook Time')?.value).toBe(1);
    expect(findProperty(read, 'cooking')).toBeUndefined();
    expect(findProperty(propertyData(OBSIDIAN), 'Goes With')?.type).toBe('wikilink');
  });
});

describe('a wikilink value', () => {
  it('is exactly one wikilink to a page', () => {
    expect(propertyWikilink('[[Tomato soup]]')).toEqual({
      source: '[[Tomato soup]]',
      target: 'Tomato soup',
      heading: null,
      shown: null,
      embed: false,
    });
    expect(propertyWikilink('[[Recipes/Soup#Method|how]]')).toMatchObject({
      target: 'Recipes/Soup',
      heading: 'Method',
      shown: 'how',
    });
    for (const value of [
      'Tomato soup',
      ' [[Tomato soup]]',
      '[[A]] [[B]]',
      '[[A]], [[B]]',
      '![[photo.png]]',
      '[[Page#^block]]',
      '[[]]',
      '[[#Heading]]',
      '[[a\nb]]',
      ['[[A]]'],
      35,
      null,
    ] as PropertyValue[]) {
      expect(propertyWikilink(value), JSON.stringify(value)).toBeNull();
    }
  });
});
