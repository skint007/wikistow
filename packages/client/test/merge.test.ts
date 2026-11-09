import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { AttachmentId, newPayload, pageMerge, type PagePayload } from '../src/index.ts';

const { blocksOf, mergePayloads, resolve, wordMarks } = pageMerge;
type Choice = pageMerge.Choice;
type Merge = pageMerge.Merge;

const page = (markdown: string, more: Partial<PagePayload> = {}) =>
  newPayload({ title: 'Lasagne', markdown, ...more });

/** The payload saved, choosing `choices`; throws if anything still needs a choice. */
function saved(merge: Merge, choices: Record<string, Choice> = {}): PagePayload {
  const resolved = resolve(merge, choices);
  if (!resolved.ok) {
    throw new Error(`Didn't fit: ${resolved.merge.overlaps.map((o) => o.id).join(', ')}`);
  }
  return resolved.payload;
}

/** The three Markdown versions merged with nothing to choose. */
function combined(base: string, yours: string, theirs: string): string {
  const merge = mergePayloads(page(base), page(yours), page(theirs));
  expect(merge.overlaps).toEqual([]);
  return saved(merge).markdown;
}

/** The body overlaps of merging three Markdown versions, as yours and theirs. */
function overlaps(base: string, yours: string, theirs: string) {
  const merge = mergePayloads(page(base), page(yours), page(theirs));
  return merge.overlaps.map((overlap) =>
    overlap.part === 'body' ? { yours: overlap.yours, theirs: overlap.theirs } : overlap.id,
  );
}

const lines = (...text: string[]) => text.map((line) => `${line}\n`).join('');

describe('blocks', () => {
  const corpus = new URL('./corpus/', import.meta.url);
  it.each(readdirSync(corpus))('join back into %s byte for byte', (name) => {
    const body = readFileSync(new URL(name, corpus), 'utf8');
    expect(
      blocksOf(body)
        .map((block) => block.text)
        .join(''),
    ).toBe(body);
  });

  it('cut a page into leaf blocks, list items, table rows and blank lines', () => {
    const body = lines(
      '# Lasagne',
      '',
      '- onion',
      '  - chopped',
      '- [x] beef',
      '',
      '| Step | Minutes |',
      '| --- | --- |',
      '| Bake | 45 |',
      '',
      '> [!TIP]',
      '> Rest it.',
      '',
      '```',
      'code',
      '',
      '```',
    );
    expect(blocksOf(body).map((block) => [block.kind, block.text])).toEqual([
      ['heading', '# Lasagne\n'],
      ['blank', '\n'],
      ['item', '- onion\n'],
      ['item', '  - chopped\n'],
      ['item', '- [x] beef\n'],
      ['blank', '\n'],
      ['table', '| Step | Minutes |\n| --- | --- |\n'],
      ['row', '| Bake | 45 |\n'],
      ['blank', '\n'],
      ['other', '> [!TIP]\n> Rest it.\n'],
      ['blank', '\n'],
      ['other', '```\ncode\n\n```\n'],
    ]);
  });

  it('compare by what they read as, with their place', () => {
    const key = (body: string) => blocksOf(body).map((block) => block.key);
    // Bullets, emphasis, heading marks, padding and numbers are style.
    expect(key('* *a*\n')).toEqual(key('- _a_\n'));
    expect(key('Title\n=====\n')).toEqual(key('# Title\n'));
    expect(key('| a | b |\n|---|---|\n| 1 | 2 |\n')).toEqual(
      key('| a   | b   |\n| --- | --- |\n| 1   | 2   |\n'),
    );
    expect(key('1. a\n2. b\n')).toEqual(key('1. a\n1. b\n'));
    expect(key('a\r\n')).toEqual(key('a\n'));
    // A list's kind, depth, a task's tick, a quote's alert are not.
    expect(key('- a\n')).not.toEqual(key('1. a\n'));
    expect(key('- a\n')).not.toEqual(key('- [ ] a\n'));
    expect(key('- [ ] a\n')).not.toEqual(key('- [x] a\n'));
    expect(key('- x\n  - a\n').at(-1)).not.toEqual(key('- x\n- a\n').at(-1));
    expect(key('> [!NOTE]\n>\n> a\n').at(-1)).not.toEqual(key('> [!TIP]\n>\n> a\n').at(-1));
    // A table's alignment is in its header.
    expect(key('| a |\n| --- |\n')).not.toEqual(key('| a |\n| :-: |\n'));
  });
});

const LIST = lines('# Shopping', '', '- eggs', '- milk', '- bread', '- tea', '', 'Thanks!');

describe('merging the body', () => {
  it('counts each side’s changes that combined, but not blank lines alone', () => {
    const base = lines('# House', '', '', 'Bins Tuesday.', '', '- [ ] boiler');
    const yours = lines('# House', '', 'Bins Tuesday.', '', '- [x] boiler');
    const merge = mergePayloads(page(base), page(yours), page(base.replace('Bins', 'Bin day')));
    expect(merge.combined).toEqual({ yours: 1, theirs: 1 });
  });

  it('combines edits to neighbouring items', () => {
    expect(
      combined(LIST, LIST.replace('milk', 'oat milk'), LIST.replace('bread', 'rye bread')),
    ).toBe(LIST.replace('milk', 'oat milk').replace('bread', 'rye bread'));
  });

  it('keeps both additions at one place, theirs first', () => {
    expect(
      combined(
        LIST,
        LIST.replace('- tea\n', '- tea\n- jam\n'),
        LIST.replace('- tea\n', '- tea\n- figs\n'),
      ),
    ).toBe(LIST.replace('- tea\n', '- tea\n- figs\n- jam\n'));
    // Two paragraphs added at one place don't run into one.
    expect(combined(LIST, `${LIST}\nMine.\n`, `${LIST}\nTheirs.\n`)).toBe(
      `${LIST}\nTheirs.\n\nMine.\n`,
    );
    // Nor table rows, which stay one table.
    const table = lines('| a | b |', '| --- | --- |', '| 1 | 2 |');
    expect(combined(table, `${table}| 3 | 4 |\n`, `${table}| 5 | 6 |\n`)).toBe(
      `${table}| 5 | 6 |\n| 3 | 4 |\n`,
    );
    // Inside a block quote, the blank line between is the quote's.
    const quote = lines('> a');
    expect(combined(quote, `${quote}>\n> Mine.\n`, `${quote}>\n> Theirs.\n`)).toBe(
      lines('> a', '>', '> Theirs.', '>', '> Mine.'),
    );
    // A quote's `>` lines separate its blocks as blank lines do.
    const tip = lines('> [!TIP]', '> Rest it for 10 minutes.');
    expect(combined(tip, tip.replace('10', '15'), `${tip}>\n> Freezes well.\n`)).toBe(
      `${tip.replace('10', '15')}>\n> Freezes well.\n`,
    );
    // So two paragraphs one side made one quote stay one quote.
    const two = lines('Bring a coat.', '', 'Bring boots.');
    const quoted = lines('> Bring a coat.', '>', '> Bring boots.');
    expect(combined(two, quoted, two)).toBe(quoted);
    expect(combined(quoted, two, quoted)).toBe(two);
  });

  it('writes a heading both added once', () => {
    const base = lines('## Unreleased', '', '#### App', '', '- Old.');
    const yours = `${base}${lines('', '#### CLI', '', '- Mine.')}`;
    const theirs = `${base}${lines('', '#### CLI', '', '- Theirs.')}`;
    expect(combined(base, yours, theirs)).toBe(
      `${base}${lines('', '#### CLI', '', '- Theirs.', '- Mine.')}`,
    );
  });

  it('takes neighbouring blocks each side removed, at the end of a page too', () => {
    const notes = lines('Note 1', '', 'Note 2', '', 'Note 3');
    expect(combined(notes, notes.replace('Note 2\n\n', ''), notes.replace('\n\nNote 3', ''))).toBe(
      'Note 1\n',
    );
  });

  it('keeps both additions at a list’s end where one side also edits what follows', () => {
    const soup = lines('- leek', '- potato', '', '## Method');
    const yours = lines('- leek', '- potato', '- salt', '', '## Method (20 min)');
    expect(combined(soup, yours, soup.replace('potato\n', 'potato\n- carrot\n'))).toBe(
      lines('- leek', '- potato', '- carrot', '- salt', '', '## Method (20 min)'),
    );
    // But a nested item the other side added there, landing under yours' item, doesn't fit.
    const kit = lines('- [ ] Tent', '- [ ] Torch');
    const nested = lines('- [ ] Tent', '  - from Pat', '- [x] Torch');
    const stove = mergePayloads(
      page(kit),
      page(kit.replace('Torch', 'Stove\n- [ ] Torch')),
      page(nested),
    );
    expect(resolve(stove, {}).ok).toBe(false);
  });

  it('keeps a nested item under its parent the other side changed', () => {
    const minutes = lines('## Minutes', '', "- Treasurer's report", '- Summer trip');
    const theirs = lines(
      '## Minutes',
      '',
      'Present: all.',
      '',
      "- Treasurer's report (late)",
      '- Summer trip',
    );
    expect(combined(minutes, minutes.replace('report\n', 'report\n  - dues\n'), theirs)).toBe(
      theirs.replace('(late)\n', '(late)\n  - dues\n'),
    );
  });

  it('keeps a list one side outdented an item of whole', () => {
    const months = lines('* March', '  * Sam', '* July', '  * Mum');
    const yours = lines('- March', '  - Sam', '- July (60th!)', '  - Mum');
    expect(combined(months, yours, lines('* March', '* Sam', '* July', '  * Mum'))).toBe(
      lines('* March', '* Sam', '* July (60th!)', '  * Mum'),
    );
  });

  it('keeps a paragraph one side added with the one it edited beside it', () => {
    const boiler = lines('# Boiler', '', 'It is in the loft.', '', 'Call Pat.');
    const yours = lines(
      '# Boiler',
      '',
      'Serviced in May.',
      '',
      'It is in the loft, behind the door.',
      '',
      'Call Pat.',
    );
    const merge = mergePayloads(page(boiler), page(yours), page(boiler.replace('loft', 'attic')));
    expect(merge.overlaps).toMatchObject([
      {
        yours: 'Serviced in May.\n\nIt is in the loft, behind the door.\n',
        theirs: 'It is in the attic.\n',
      },
    ]);
  });

  it('lines up blocks with text before blank lines', () => {
    // Theirs adds a note and removes the last; yours edits the one between.
    const notes = lines('Bins Tuesday.', '', 'Dentist on the 12th.', '', 'Gran Sunday.');
    const theirs = lines('Bins Tuesday.', '', 'Car MOT.', '', 'Dentist on the 12th.');
    expect(combined(notes, notes.replace('12th', '14th'), theirs)).toBe(
      theirs.replace('12th', '14th'),
    );
    // An addition just above the other side's removal of the page's end stays apart from it.
    const sections = lines('## A', '', 'a text', '', '## B', '', 'b text');
    expect(
      combined(
        sections,
        sections.replace('a text\n', 'a text\n\nmore a\n'),
        lines('## A', '', 'a text'),
      ),
    ).toBe(lines('## A', '', 'a text', '', 'more a'));
  });

  it('starts a numbered list where yours renumbered it after taking its first item', () => {
    const jobs = lines('1. Mow', '2. Fix the gate', '3. Paint', '', 'Thanks!');
    const yours = lines('1. Fix the gate', '2. Paint', '', 'Thanks!');
    expect(combined(jobs, yours, jobs.replace('Thanks!', 'Thanks, all!'))).toBe(
      lines('1. Fix the gate', '3. Paint', '', 'Thanks, all!'),
    );
    // Or at its list's first number, where neither side had it first.
    const method = lines('1. Heat', '2. Brown', '3. Bake');
    expect(combined(method, lines('1. Brown', '2. Bake'), lines('1. Heat', '2. Bake'))).toBe(
      '1. Bake\n',
    );
    // In its own delimiter.
    const brackets = jobs.replace(/\. /g, ') ');
    expect(combined(brackets, yours, brackets.replace('Thanks!', 'Thanks, all!'))).toBe(
      lines('1) Fix the gate', '3) Paint', '', 'Thanks, all!'),
    );
  });

  it('joins two lists where one side took out what was between them', () => {
    const packing = lines(
      '## Clothes',
      '',
      '- socks',
      '',
      '## Toiletries',
      '',
      '- paste',
      '',
      'Remember the charger.',
    );
    const joined = packing.replace('## Toiletries\n\n', '');
    expect(combined(packing, joined, packing.replace('charger', 'chargers'))).toBe(
      joined.replace('charger', 'chargers'),
    );
  });

  it('keeps a numbered list apart from the bullets before it', () => {
    const pancakes = lines('- 2 eggs', '- milk', '', '1. Whisk.', '2. Add the milk.', '3. Fry.');
    const theirs = lines('- 2 eggs', '- milk', '', '1. Add the milk.', '2. Fry.');
    expect(combined(pancakes, pancakes.replace('milk.', 'milk slowly.'), theirs)).toBe(
      theirs.replace('milk.', 'milk slowly.'),
    );
  });

  it('keeps a quote whole beside changes around it', () => {
    const base = lines('# H', '', '> quote', '', 'end');
    expect(
      combined(
        base,
        lines('# H', '', '> quote', '>', '> more'),
        lines('# H', '', 'new', '', '> Quote', '', 'end'),
      ),
    ).toBe(lines('# H', '', 'new', '', '> Quote', '>', '> more'));
  });

  it('takes a block one side moved, and stops where the other edited it', () => {
    const moved = lines('# Shopping', '', '- tea', '- eggs', '- milk', '- bread', '', 'Thanks!');
    expect(combined(LIST, moved, LIST.replace('milk', 'oat milk'))).toBe(
      moved.replace('milk', 'oat milk'),
    );
    expect(overlaps(LIST, moved, LIST.replace('tea', 'green tea'))).toHaveLength(1);
  });

  it('combines with a table the visual editor aligned, aligned again', () => {
    const base = lines('| Step | Minutes |', '|---|---|', '| Fry | 10 |', '| Bake | 45 |');
    const theirs = lines(
      '| Step | Minutes |',
      '| ---- | ------- |',
      '| Fry  | 10      |',
      '| Bake | 45      |',
    );
    const yours = `${base}| Rest it | 15 |\n`;
    expect(combined(base, yours, theirs)).toBe(
      lines(
        '| Step    | Minutes |',
        '| ------- | ------- |',
        '| Fry     | 10      |',
        '| Bake    | 45      |',
        '| Rest it | 15      |',
      ),
    );
  });

  it('combines with a list renumbered', () => {
    const base = lines('1. Fry', '1. Layer', '1. Bake');
    const theirs = lines('1. Fry', '2. Layer', '3. Bake');
    // The item yours changed keeps its number: only the first item's is read.
    expect(combined(base, base.replace('Bake', 'Bake at 190'), theirs)).toBe(
      theirs.replace('3. Bake', '1. Bake at 190'),
    );
    // An edited first item keeps where the list starts.
    expect(combined(base, base.replace('Fry', 'Fry the onion'), theirs)).toBe(
      theirs.replace('Fry', 'Fry the onion'),
    );
  });

  it('combines with a page the visual editor restyled', () => {
    const base = lines(
      'Lasagne',
      '=======',
      '',
      '* _Serves_ six',
      '* Freezes well',
      '',
      'Bake it.',
    );
    const theirs = lines('# Lasagne', '', '- *Serves* six', '- Freezes well', '', 'Bake it.');
    expect(combined(base, base.replace('Bake it.', 'Bake it at 190.'), theirs)).toBe(
      theirs.replace('Bake it.', 'Bake it at 190.'),
    );
  });

  it('counts indenting an item as a change to it', () => {
    const base = lines('- eggs', '- milk', '- bread');
    const indented = lines('- eggs', '  - milk', '- bread');
    expect(combined(base, indented, base.replace('bread', 'rye bread'))).toBe(
      indented.replace('bread', 'rye bread'),
    );
    expect(overlaps(base, indented, base.replace('milk', 'oat milk'))).toEqual([
      { yours: '  - milk\n', theirs: '- oat milk\n' },
    ]);
  });

  it('counts turning a list from bullets to numbers as a change to each item', () => {
    const base = lines('- eggs', '- milk', '- bread');
    const numbered = lines('1. eggs', '2. milk', '3. bread');
    expect(overlaps(base, base.replace('milk', 'oat milk'), numbered)).toEqual([
      { yours: '- oat milk\n', theirs: '2. milk\n' },
    ]);
  });

  it('sends back only the item picked from a list the other side numbered', () => {
    const base = lines('- Preheat', '- Chop', '- Brown', '- Bake');
    const numbered = lines('1. Preheat', '2. Chop', '3. Brown', '4. Bake');
    const at = (yours: string) => {
      const merge = mergePayloads(page(base), page(yours), page(numbered));
      const resolved = resolve(merge, { [merge.overlaps[0]?.id ?? '']: 'yours' });
      if (resolved.ok) throw new Error('It fitted.');
      return resolved.merge.overlaps.filter((o) => o.part === 'body' && !o.fits);
    };
    expect(at(base.replace('Chop', 'Chop finely'))).toMatchObject([
      { yours: '- Chop finely\n', draft: '2. Chop finely\n' },
    ]);
    // So does an item the other side added at its top.
    const top = resolve(
      mergePayloads(page(base), page(numbered), page(`- Buy cheese\n${base}`)),
      {},
    );
    expect(top.ok).toBe(false);
    // An item yours added there comes back alone too.
    const added = resolve(
      mergePayloads(page(base), page(base.replace('- Chop', '- Crush\n- Chop')), page(numbered)),
      {},
    );
    if (added.ok) throw new Error('It fitted.');
    expect(added.merge.overlaps).toMatchObject([{ yours: '- Crush\n', draft: '2. Crush\n' }]);
    // First in the list, it takes the number before the next one's.
    expect(at(base.replace('Preheat', 'Preheat to 180'))).toMatchObject([
      { yours: '- Preheat to 180\n', draft: '1. Preheat to 180\n' },
    ]);
  });

  it('counts turning a list into a checklist as a change to each item', () => {
    const base = lines('- eggs', '- milk');
    const checklist = lines('- [ ] eggs', '- [ ] milk');
    expect(overlaps(base, checklist, base.replace('eggs', 'six eggs'))).toEqual([
      { yours: '- [ ] eggs\n', theirs: '- six eggs\n' },
    ]);
    expect(combined(base, checklist, `${base}- tea\n`)).toBe(`${checklist}- tea\n`);
  });

  it('writes an item from a * list in the style of the - list it lands in', () => {
    const base = lines('- eggs', '- milk');
    const restyled = lines('* eggs', '* milk', '* tea');
    expect(combined(base, restyled, base.replace('eggs', 'six eggs'))).toBe(
      lines('- six eggs', '- milk', '- tea'),
    );
    // A tick beside the other side's restyled list is written in that style.
    const tasks = lines('* [ ] tent', '* [ ] stove', '* [ ] mats');
    expect(
      combined(
        tasks,
        tasks.replace('[ ] stove', '[x] stove'),
        lines('- [x] tent', '- [ ] stove', '- [ ] mats'),
      ),
    ).toBe(lines('- [x] tent', '- [x] stove', '- [ ] mats'));
    // And a first item changed next to the other side's change takes the rest's style.
    const shopping = lines('* [ ] milk', '* [ ] bread', '* [ ] eggs');
    expect(
      combined(
        shopping,
        lines('- [x] milk', '- [ ] bread', '- [ ] eggs'),
        shopping.replace('[ ] bread', '[x] bread'),
      ),
    ).toBe(lines('* [x] milk', '* [x] bread', '* [ ] eggs'));
    // But not from the next list, past the end of its own.
    const packing = lines('- [ ] tent', '- [ ] stove', '', '* passports', '* tickets');
    expect(
      combined(
        packing,
        packing.replace('[ ] tent', '[x] tent'),
        packing.replace('[ ] stove', '[x] stove'),
      ),
    ).toBe(lines('- [x] tent', '- [x] stove', '', '* passports', '* tickets'));
    // Nor from an item its own side added, which is fitted to the list itself.
    expect(
      combined(
        lines('* a', '* b', '* c'),
        lines('- A', '- b', '- n', '- c'),
        lines('* a', '* B', '* c'),
      ),
    ).toBe(lines('* A', '* B', '* n', '* c'));
    // Lists of two kinds both added at one place stay two lists.
    expect(combined('Soup.\n', 'Soup.\n\n- tip\n', 'Soup.\n\n1. Boil\n')).toBe(
      'Soup.\n\n1. Boil\n\n- tip\n',
    );
    // Or beside one with another bullet, which Markdown reads as another list.
    const trip = lines(
      '# Trip',
      '',
      '- tent',
      '- stove',
      '',
      '* [ ] book campsite',
      '* [ ] pack car',
    );
    expect(
      combined(trip, trip.replace('[ ] book', '[x] book'), trip.replace('Trip', 'Trip 2026')),
    ).toBe(trip.replace('[ ] book', '[x] book').replace('Trip', 'Trip 2026'));
    // A list of its own on its side stays its own, beside a list of the other kind.
    const two = lines('- flour', '- eggs', '', '1. Mix', '2. Bake');
    expect(combined(two, two.replace('Mix', 'Mix well'), two.replace('flour', 'rye flour'))).toBe(
      two.replace('Mix', 'Mix well').replace('flour', 'rye flour'),
    );
  });

  describe('a run of ticks on one side', () => {
    const base = lines(
      '- [ ] one',
      '- [ ] two',
      '- [ ] three',
      '- [ ] four',
      '- [ ] five',
      '- [ ] six',
    );
    const ticked = base.replace(/\[ \] (two|three|four|five)/g, '[x] $1');

    it('combines with a single tick inside it', () => {
      expect(combined(base, ticked, base.replace('[ ] four', '[x] four'))).toBe(ticked);
    });

    it('overlaps on the one item the other side edited', () => {
      expect(overlaps(base, ticked, base.replace('five', 'fifth'))).toEqual([
        { yours: '- [x] five\n', theirs: '- [ ] fifth\n' },
      ]);
    });

    it('combines with an item added inside it', () => {
      expect(combined(base, ticked, base.replace('- [ ] five', '- [ ] 4½\n- [ ] five'))).toBe(
        ticked.replace('- [x] five', '- [ ] 4½\n- [x] five'),
      );
    });

    it('overlaps on the one item the other side removed', () => {
      expect(overlaps(base, ticked, base.replace('- [ ] three\n', ''))).toEqual([
        { yours: '- [x] three\n', theirs: '' },
      ]);
    });

    it('with an item added at its end, is one overlap with a tick inside it', () => {
      const more = ticked.replace('- [x] five\n', '- [x] five\n- [ ] milk\n');
      const found = overlaps(base, more, base.replace('[ ] three', '[x] three'));
      expect(found).toHaveLength(1);
      expect(found[0]).toEqual({
        yours: lines('- [x] two', '- [x] three', '- [x] four', '- [x] five', '- [ ] milk'),
        theirs: lines('- [ ] two', '- [x] three', '- [ ] four', '- [ ] five'),
      });
    });
  });

  it('sends a block that reads differently where it went back as an overlap', () => {
    const base = lines('- eggs', '- milk');
    const numbered = lines('1. eggs', '2. milk');
    const merge = mergePayloads(page(base), page(`${base}- tea\n`), page(numbered));
    expect(merge.overlaps).toEqual([]);
    const resolved = resolve(merge, {});
    if (resolved.ok) throw new Error('It fitted.');
    expect(resolved.merge.overlaps).toMatchObject([
      {
        id: 'body:2:fit',
        fits: false,
        // Edit… starts with it written into the list it lands in.
        draft: '3. tea\n',
        yours: '- tea\n',
        theirs: '',
        offers: ['yours', 'theirs', 'edit'],
      },
    ]);
    // Yours' one change is now a place to choose, not one that combined.
    expect([merge.combined, resolved.merge.combined]).toEqual([
      { yours: 1, theirs: 2 },
      { yours: 0, theirs: 2 },
    ]);
    // Picked there, it is written as yours has it, and taken as it reads.
    expect(saved(resolved.merge, { 'body:2:fit': 'yours' }).markdown).toBe(`${numbered}- tea\n`);
    expect(saved(resolved.merge, { 'body:2:fit': 'theirs' }).markdown).toBe(numbered);
    expect(saved(resolved.merge, { 'body:2:fit': { edit: '3. tea' } }).markdown).toBe(
      `${numbered}3. tea\n`,
    );
  });

  it('starts Edit… with theirs in the list’s style, where yours has nothing there', () => {
    const base = lines('- Fry', '- Bake');
    const resolved = resolve(
      mergePayloads(page(base), page(lines('1. Fry', '2. Bake')), page(`${base}- Serve\n`)),
      {},
    );
    if (resolved.ok) throw new Error('It fitted.');
    expect(resolved.merge.overlaps).toMatchObject([
      { yours: '', theirs: '- Serve\n', draft: '3. Serve\n' },
    ]);
  });

  it('lands a nested item picked at a block that didn’t fit at another depth', () => {
    const base = lines('- eggs', '- milk');
    const yours = lines('- eggs', '  - free range', '- milk');
    const theirs = lines('10. eggs', '11. milk');
    const resolved = resolve(mergePayloads(page(base), page(yours), page(theirs)), {});
    if (resolved.ok) throw new Error('It fitted.');
    const fit = resolved.merge.overlaps.find((o) => o.part === 'body' && !o.fits);
    expect(fit).toMatchObject({
      yours: '  - free range\n',
      theirs: '',
      draft: '    - free range\n',
    });
    // As yours has it, under a wider marker, it is a list of its own at the top.
    const markdown = saved(resolved.merge, { [fit?.id ?? '']: 'yours' }).markdown;
    expect(markdown).toBe(lines('10. eggs', '  - free range', '11. milk'));
    expect(blocksOf(markdown)[1]?.place).toEqual([{ kind: 'list', ordered: false }]);
  });

  it('writes a nested item under its parent’s marker', () => {
    const base = lines('- eggs', '- milk');
    const yours = lines('- eggs', '  - free range', '- milk');
    expect(combined(base, yours, lines('- six eggs', '- milk'))).toBe(
      lines('- six eggs', '  - free range', '- milk'),
    );
    // Beside items nested with a tab, as Obsidian writes them, it is nested the same.
    const packing = lines('- Packing', '\t- socks', '- Tickets');
    expect(
      combined(
        packing,
        packing.replace('\t- socks', '\t- passport\n\t- socks'),
        packing.replace('Tickets', 'Tickets!'),
      ),
    ).toBe(lines('- Packing', '\t- passport', '\t- socks', '- Tickets!'));
    // Under a numbered parent, a nested item theirs left alone keeps its indentation.
    const nested = lines('- a', '  - a1', '- b');
    const resolved = resolve(
      mergePayloads(
        page(nested),
        page(nested.replace('a1\n', 'a1\n  - a2\n')),
        page(lines('1. a', '   - a1', '2. b')),
      ),
      {},
    );
    if (resolved.ok) throw new Error('It fitted.');
    expect(resolved.merge.overlaps).toMatchObject([{ fits: false, yours: '  - a2\n' }]);
  });

  it('ends as theirs does, with a line ending or without', () => {
    expect(combined('a', 'a\n\nMine.', 'a\n\nTheirs.')).toBe('a\n\nTheirs.\n\nMine.');
    expect(combined('a', 'a\n\nMine.', 'a\n\nTheirs.\n')).toBe('a\n\nTheirs.\n\nMine.\n');
  });

  it('offers the choices at an overlap, with context', () => {
    const merge = mergePayloads(
      page(LIST),
      page(LIST.replace('milk', 'oat milk')),
      page(LIST.replace('milk', 'goat milk')),
    );
    expect(merge.overlaps).toEqual([
      {
        id: 'body:1',
        part: 'body',
        offers: ['yours', 'theirs', 'both', 'edit'],
        base: '- milk\n',
        yours: '- oat milk\n',
        theirs: '- goat milk\n',
        fits: true,
        under: 'Shopping',
        before: '- eggs\n',
        draft: '- oat milk\n',
      },
    ]);
    const at = (choice: Choice) => saved(merge, { 'body:1': choice }).markdown;
    expect(at('yours')).toBe(LIST.replace('milk', 'oat milk'));
    expect(at('theirs')).toBe(LIST.replace('milk', 'goat milk'));
    expect(at('both')).toBe(LIST.replace('- milk', '- goat milk\n- oat milk'));
    expect(at({ edit: '- milk (any)' })).toBe(LIST.replace('milk', 'milk (any)'));
    // Edit… text is taken as it reads, between the blank lines around it.
    expect(at({ edit: 'oat milk' })).toBe(LIST.replace('- milk', 'oat milk'));
    const paragraphs = lines('Para one.', '', 'Para two.', '', 'Para three.');
    const gone = mergePayloads(
      page(paragraphs),
      page(paragraphs.replace('Para two.\n\n', '')),
      page(paragraphs.replace('two.', 'two, edited.')),
    );
    expect(gone.overlaps).toMatchObject([
      { yours: '', theirs: 'Para two, edited.\n', draft: 'Para two, edited.\n' },
    ]);
    const [overlap] = gone.overlaps;
    expect(saved(gone, { [overlap?.id ?? '']: { edit: 'Para two, fixed.' } }).markdown).toBe(
      paragraphs.replace('two.', 'two, fixed.'),
    );
    expect(() => resolve(merge, {})).toThrow();
  });
});

const FRONT = lines('---', 'tags: [recipe, dinner]', 'servings: 6', 'time: 90', '---');

describe('merging the front matter', () => {
  const markdown = (frontmatter: string) => `${frontmatter}Bake it.\n`;
  const merged = (yours: string, theirs: string) =>
    mergePayloads(page(markdown(FRONT)), page(markdown(yours)), page(markdown(theirs)));

  it('merges by key, starting from theirs’ text', () => {
    const yours = FRONT.replace('servings: 6', 'servings: 8').replace(
      'time: 90\n',
      'time: 90\nvegetarian: false\n',
    );
    const theirs = FRONT.replace('time: 90', 'time: "1h 30m"');
    expect(saved(merged(yours, theirs)).markdown).toBe(
      markdown(
        lines(
          '---',
          'tags: [recipe, dinner]',
          'servings: 8',
          'time: "1h 30m"',
          'vegetarian: false',
          '---',
        ),
      ),
    );
  });

  it('counts each key a side changed, merged by key or whole', () => {
    const theirs = FRONT.replace('6', '4').replace('90', '60');
    expect(merged(FRONT, theirs).combined).toEqual({ yours: 0, theirs: 2 });
    expect(merged(FRONT.replace('[recipe, dinner]', '[recipe]'), theirs).combined).toEqual({
      yours: 1,
      theirs: 2,
    });
  });

  it('takes a key one side removed', () => {
    expect(saved(merged(FRONT.replace('time: 90\n', ''), FRONT.replace('6', '4'))).markdown).toBe(
      markdown(lines('---', 'tags: [recipe, dinner]', 'servings: 4', '---')),
    );
  });

  it('merges tags by item, in theirs’ style', () => {
    const yours = FRONT.replace('[recipe, dinner]', '[recipe, easy]');
    const theirs = FRONT.replace('[recipe, dinner]', '["recipe", "dinner", "pasta"]');
    expect(saved(merged(yours, theirs)).markdown).toBe(
      markdown(FRONT.replace('[recipe, dinner]', '["recipe", "pasta", "easy"]')),
    );
  });

  it('overlaps on a key both changed, shown as its lines', () => {
    const merge = merged(FRONT.replace('6', '8'), FRONT.replace('6', '4'));
    expect(merge.overlaps).toEqual([
      {
        id: 'property:servings',
        part: 'property',
        key: 'servings',
        offers: ['yours', 'theirs', 'edit'],
        base: 'servings: 6\n',
        yours: 'servings: 8\n',
        theirs: 'servings: 4\n',
        draft: 'servings: 8\n',
      },
    ]);
    expect(saved(merge, { 'property:servings': 'yours' }).markdown).toBe(
      markdown(FRONT.replace('6', '8')),
    );
    expect(saved(merge, { 'property:servings': { edit: 'servings: 7' } }).markdown).toBe(
      markdown(FRONT.replace('6', '7')),
    );
  });

  it('leaves no empty block where yours removed it all', () => {
    const merge = merged('', FRONT.replace('6', '4'));
    expect(saved(merge, { 'property:servings': 'yours' }).markdown).toBe(markdown(''));
  });

  it('merges a block that isn’t keys as one field', () => {
    const list = lines('---', '- a', '---');
    const merge = mergePayloads(
      page(markdown(list)),
      page(markdown(lines('---', '- b', '---'))),
      page(markdown(lines('---', '- c', '---'))),
    );
    expect(merge.overlaps.map((o) => o.id)).toEqual(['frontmatter']);
    expect(saved(merge, { frontmatter: 'yours' }).markdown).toBe(
      markdown(lines('---', '- b', '---')),
    );
  });
});

describe('merging the rest of the payload', () => {
  const ref = (id: string) => ({
    id: AttachmentId.parse(id),
    name: `${id}.png`,
    mediaType: 'image/png',
    size: 1,
    key: 'a2V5',
    blobHash: 'aGFzaA',
  });
  const attachments = (payload: PagePayload) => payload.attachments.map(({ id }) => id);

  it('overlaps on a title both changed, and takes one changed alone', () => {
    const base = page('a\n');
    expect(saved(mergePayloads(base, { ...base, title: 'Mine' }, base)).title).toBe('Mine');
    const merge = mergePayloads(base, { ...base, title: 'Mine' }, { ...base, title: 'Theirs' });
    expect(merge.overlaps.map((o) => o.id)).toEqual(['title']);
    expect(saved(merge, { title: { edit: 'Both' } }).title).toBe('Both');
  });

  it('keeps attachments either side added, less any either removed, unless still named', () => {
    const base = page('![](attachment:keep)\n', {
      attachments: [ref('keep'), ref('gone'), ref('named')],
    });
    const yours = {
      ...base,
      markdown: `${base.markdown}![](attachment:named)\n`,
      attachments: [ref('keep'), ref('named'), ref('mine')],
    };
    const theirs = { ...base, attachments: [ref('keep'), ref('gone'), ref('theirs')] };
    // `gone` yours removed; `named` theirs removed, but the text still names it.
    expect(attachments(saved(mergePayloads(base, yours, theirs)))).toEqual([
      'keep',
      'theirs',
      'named',
      'mine',
    ]);
  });

  it('merges the banner and the icon as fields', () => {
    const cover = (fields: object) => ({ 'wikistow.cover': { format: 1, ...fields } });
    const base = page('a\n', { extensions: cover({ emoji: '🍝' }) });
    const yours = {
      ...base,
      extensions: cover({ emoji: '🍝', banner: { kind: 'preset', name: 'ocean' } }),
    };
    const theirs = { ...base, extensions: cover({ symbol: { name: 'chef-hat' } }) };
    const both = saved(mergePayloads(base, yours, theirs));
    expect(both.extensions['wikistow.cover']).toEqual({
      format: 1,
      symbol: { name: 'chef-hat' },
      banner: { kind: 'preset', name: 'ocean' },
    });
    // The icon is one field, whether an emoji, an icon or an image.
    const merge = mergePayloads(base, { ...base, extensions: cover({ emoji: '🍲' }) }, theirs);
    expect(merge.overlaps).toMatchObject([
      {
        id: 'icon',
        part: 'icon',
        yours: { emoji: '🍲' },
        theirs: { symbol: { name: 'chef-hat' } },
        offers: ['yours', 'theirs'],
      },
    ]);
    expect(saved(merge, { icon: 'yours' }).extensions['wikistow.cover']).toEqual({
      format: 1,
      emoji: '🍲',
    });
  });

  it('merges other data by namespace, and link tables by entry', () => {
    const links = (...keys: string[]) => ({
      format: 1,
      links: keys.map((key) => ({ key, pageId: `p-${key}` })),
    });
    const base = page('a\n', {
      extensions: { 'recipe.cards': { n: 1 }, 'wikistow.links': links('a') },
    });
    const yours = {
      ...base,
      extensions: { 'recipe.cards': { n: 2 }, 'wikistow.links': links('a', 'b'), 'mine.data': [1] },
    };
    const theirs = {
      ...base,
      extensions: { 'recipe.cards': { n: 3 }, 'wikistow.links': links('a', 'c') },
    };
    const merge = mergePayloads(base, yours, theirs);
    expect(merge.overlaps).toMatchObject([
      {
        id: 'data:recipe.cards',
        part: 'data',
        namespace: 'recipe.cards',
        yours: { n: 2 },
        theirs: { n: 3 },
      },
    ]);
    expect(saved(merge, { 'data:recipe.cards': 'theirs' }).extensions).toEqual({
      'recipe.cards': { n: 3 },
      'wikistow.links': links('a', 'c', 'b'),
      'mine.data': [1],
    });
  });
});

describe('resolving', () => {
  const PAGE = page(`${FRONT}${LIST}`, {
    attachments: [],
    extensions: { 'wikistow.cover': { format: 1, emoji: '🍝' }, 'recipe.cards': { n: 1 } },
  });

  it('round-trips a payload', () => {
    expect(saved(mergePayloads(PAGE, PAGE, PAGE))).toEqual(PAGE);
    const changed = { ...PAGE, title: 'New', markdown: `${PAGE.markdown}\nMore.\n` };
    expect(saved(mergePayloads(PAGE, changed, PAGE))).toEqual(changed);
    expect(saved(mergePayloads(PAGE, PAGE, changed))).toEqual(changed);
    expect(saved(mergePayloads(PAGE, changed, changed))).toEqual(changed);
  });

  it('reviews a changed block once, beside one taken out', () => {
    const bake = '- Bake at 180 °C for 45 minutes.\n';
    const base = page(`${bake}- Use fresh sheets.\n- Serve.\n`);
    const yours = { ...base, markdown: `${bake.replace('180', '190')}- Serve.\n` };
    const resolved = resolve(mergePayloads(base, yours, base), {});
    if (!resolved.ok) throw new Error('It didn’t fit.');
    expect(resolved.review.lines.map((line) => line.kind)).toEqual(['changed', 'removed', 'same']);
    expect(resolved.review.lines[0]).toEqual({
      kind: 'changed',
      marks: wordMarks(bake, bake.replace('180', '190')),
    });
    // Each changed block is paired with the old one it is most like.
    const shopping = page(lines('- Buy eggs', '- Call Gran'));
    const more = { ...shopping, markdown: lines('- Buy milk', '- Buy eggs today', '- Call Gran') };
    const review = resolve(mergePayloads(shopping, more, shopping), {});
    if (!review.ok) throw new Error('It didn’t fit.');
    expect(review.review.lines.slice(0, 2)).toEqual([
      { kind: 'added', text: '- Buy milk\n' },
      { kind: 'changed', marks: wordMarks('- Buy eggs\n', '- Buy eggs today\n') },
    ]);
  });

  it('reviews what saving changes in theirs', () => {
    const theirs = { ...PAGE, markdown: PAGE.markdown.replace('bread', 'rye bread') };
    const yours = {
      ...PAGE,
      markdown: PAGE.markdown
        .replace('servings: 6', 'servings: 8')
        .replace('- tea\n', '- tea\n- jam\n')
        .replace('- eggs\n', ''),
      extensions: { ...PAGE.extensions, 'wikistow.cover': { format: 1, emoji: '🍲' } },
    };
    const resolved = resolve(mergePayloads(PAGE, yours, theirs), {});
    if (!resolved.ok) throw new Error('It didn’t fit.');
    expect(resolved.review.lines).toEqual([
      { kind: 'same', text: '---\ntags: [recipe, dinner]\n' },
      { kind: 'changed', marks: wordMarks('servings: 6\n', 'servings: 8\n') },
      { kind: 'same', text: 'time: 90\n---\n# Shopping\n\n' },
      { kind: 'removed', text: '- eggs\n' },
      { kind: 'same', text: '- milk\n- rye bread\n- tea\n' },
      { kind: 'added', text: '- jam\n' },
      { kind: 'same', text: '\nThanks!\n' },
    ]);
    expect(resolved.review.fields).toEqual([{ part: 'icon' }]);
    expect(wordMarks('servings: 6\n', 'servings: 8\n')).toEqual([
      { text: 'servings: ', change: 'same' },
      { text: '6', change: 'removed' },
      { text: '8', change: 'added' },
      { text: '\n', change: 'same' },
    ]);
  });
});
