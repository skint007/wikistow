import { act } from 'react';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  colour,
  merged,
  person,
  range,
  send,
  shows,
  sourcePerson,
  typeSource,
  raw,
  settle,
  together,
  toggle,
  typing,
  unmounts,
  type Edit,
} from './live-format-people.tsx';
import { viewOf } from './editor-view.ts';

// Two people formatting the same text at once in a live session, each in a
// visual editor mounted for real over a Yjs `body` of its own (#720): the
// merge reads as one person's formatting, the other's, or both, never as
// raw HTML neither wrote; and where main's character merge is right, it
// comes out the same.

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

const ORDERS = [
  [2, 1],
  [1, 2],
] as const;

describe('formatting made alongside someone else’s', () => {
  // #720's four rows: A's highlight and B's text colour of the same word.
  const rows: [string, Edit, Edit][] = [
    ['**==world==**\n', colour('world', 'highlight', 'red'), colour('world', 'text', 'red')],
    ['**world**\n', colour('world', 'highlight', 'red'), colour('world', 'text', 'red')],
    ['**world**\n', colour('world', 'highlight', 'plain'), colour('world', 'text', 'red')],
    ['==**world**==\n', colour('world', 'highlight', 'red'), colour('world', 'text', 'red')],
  ];
  for (const [i, [page, a, b]] of rows.entries()) {
    for (const ids of ORDERS) {
      it(`reads as both people’s, never raw HTML: row ${i + 1}, clients ${ids.join(' and ')}`, async () => {
        const { end, main } = await together(page, [a, b], ids);
        expect(raw(main)).toBe(true);
        expect(raw(end)).toBe(false);
        expect(end).toContain('<span data-color="red">');
        expect(end).toContain('**world**');
        expect(end).toMatch(/<mark|==/);
      });
    }
  }

  // Merges main gets right, from #736's and #737's reviews.
  const right: [string, string, Edit, Edit][] = [
    [
      'a capital',
      'Hello world there.\n',
      colour('world', 'highlight', 'red'),
      typing('world', 0, 1, 'W'),
    ],
    [
      'a typo fixed',
      'Hello wrold there.\n',
      colour('wrold', 'highlight', 'red'),
      typing('wrold', 1, 2, 'or'),
    ],
    [
      'typing inside',
      'Hello world there.\n',
      colour('world', 'highlight', 'red'),
      typing('world', 0, 0, 'wonder'),
    ],
    [
      'a letter taken out',
      'Hello world there.\n',
      colour('world', 'highlight', 'red'),
      typing('world', 3, 1, ''),
    ],
    [
      'the stop after it taken out',
      'Hello world. there\n',
      colour('world', 'highlight', 'red'),
      typing('world.', 5, 1, ''),
    ],
    [
      'two letters apart',
      'Hello world there.\n',
      colour('w', 'highlight', 'red'),
      colour('d', 'text', 'blue'),
    ],
    [
      'two words with no space',
      'Hello,world\n',
      colour('Hello', 'highlight', 'red'),
      colour('world', 'text', 'blue'),
    ],
    [
      'a word inside',
      'Completion: (50%) done.\n',
      colour('(50%)', 'highlight', 'red'),
      colour('50', 'text', 'blue'),
    ],
    [
      'far apart',
      'Hello world there.\n',
      colour('Hello', 'highlight', 'red'),
      colour('there', 'text', 'blue'),
    ],
    [
      'bold taken off',
      'Say **world** now.\n',
      colour('world', 'highlight', 'red'),
      toggle('world', 'bold'),
    ],
    [
      'both take the highlight off',
      'Hello <mark data-color="red">world</mark> there.\n',
      colour('world', 'highlight', null),
      colour('world', 'highlight', null),
    ],
  ];
  for (const [name, page, a, b] of right) {
    for (const ids of ORDERS) {
      it(`comes out as main does: ${name}, clients ${ids.join(' and ')}`, async () => {
        const { end, main } = await together(page, [a, b], ids);
        expect(raw(main)).toBe(false);
        expect(end).toBe(main);
      });
    }
  }

  // Merges main gets wrong, from #736's review: each person's formatting, or both.
  const wrong: [string, string, Edit, Edit, RegExp[]][] = [
    [
      'bold on a highlighted word',
      'Say world now.\n',
      colour('world', 'highlight', 'red'),
      toggle('world', 'bold'),
      [/<mark data-color="red">/, /\*\*/],
    ],
    [
      'the same highlight twice',
      'Say world now.\n',
      colour('world', 'highlight', 'red'),
      colour('world', 'highlight', 'red'),
      [/<mark data-color="red">world<\/mark>/],
    ],
    [
      'a highlight’s colour changed twice',
      'Say <mark data-color="red">world</mark> now.\n',
      colour('world', 'highlight', 'blue'),
      colour('world', 'highlight', 'green' as 'red'),
      [/<mark data-color="(blue|green)">world<\/mark>/],
    ],
    [
      'partial highlights over each other',
      'Hello world there.\n',
      colour('Hello wo', 'highlight', 'red'),
      colour('lo world', 'highlight', 'blue'),
      [/<mark/],
    ],
  ];
  for (const [name, page, a, b, shows] of wrong) {
    for (const ids of ORDERS) {
      it(`reads as one person’s or both: ${name}, clients ${ids.join(' and ')}`, async () => {
        const { end } = await together(page, [a, b], ids);
        expect(raw(end)).toBe(false);
        for (const show of shows) expect(end).toMatch(show);
        expect(end.replace(/<[^>]*>|\*\*|==/g, '')).toBe(page.replace(/<[^>]*>|\*\*|==/g, ''));
      });
    }
  }

  it('never takes out a third person’s change made alongside', async () => {
    const page = 'Say **world** now.\n';
    const people = [await person(page, 3), await person(page, 2), await person(page, 1)] as const;
    colour('world', 'highlight', 'red')(people[0]);
    colour('world', 'text', 'red')(people[1]);
    typing('world', 0, 1, 'W')(people[2]);
    typing('orld', 4, 0, 's')(people[2]);
    await expect
      .poll(() => people.map((p) => p.text.toJSON() === page))
      .toEqual([false, false, false]);
    await settle([...people]);
    const ends = people.map((p) => p.text.toJSON());
    expect(new Set(ends).size).toBe(1);
    const [end] = ends as [string];
    expect(raw(end)).toBe(false);
    expect(end).toContain('Worlds');
    expect(end).toContain('<span data-color="red">');
    expect(end).toContain('<mark data-color="red">');
  });

  it('is made again over a change typed in source mode, by the higher client', async () => {
    const page = '**world**\n';
    const a = await person(page, 2);
    // Someone in source mode, under a lower client, colours it by hand.
    const b = sourcePerson(page, 1);
    typeSource(b, '<span data-color="red">**world**</span>\n');
    colour('world', 'highlight', 'red')(a);
    await expect.poll(() => a.text.toJSON()).not.toBe(page);
    await settle([a, b]);
    expect(a.text.toJSON()).toBe(
      '<span data-color="red"><mark data-color="red">**world**</mark></span>\n',
    );
    expect(b.text.toJSON()).toBe(a.text.toJSON());
  });

  // Changes made with the formatting in, which show it only by where they
  // are, aren't made alongside it: they merge as main's do (#720's reviews).
  const after: [string, string, Edit, Edit][] = [
    [
      'a word un-bolded inside a bolded phrase',
      'Say one two three now.\n',
      toggle('one two three', 'bold'),
      toggle('two', 'bold'),
    ],
    [
      'a recolour inside the highlight',
      'abcdef\n',
      colour('abcdef', 'highlight', 'red'),
      colour('cd', 'highlight', 'blue'),
    ],
    [
      'letters un-bolded inside a bolded word',
      'Hello world there.\n',
      toggle('world', 'bold'),
      toggle('rl', 'bold'),
    ],
    [
      'Enter inside a bolded word',
      'Hello world there.\n',
      toggle('world', 'bold'),
      (p) => {
        const view = viewOf(p.dom);
        const [from] = range(view.state.doc, 'rld');
        act(() => view.dispatch(view.state.tr.split(from)));
      },
    ],
  ];
  for (const [name, page, a, b] of after) {
    it(`leaves a change made after it as main does: ${name}`, async () => {
      const [pa, pb] = [await person(page, 2), await person(page, 1)];
      a(pa);
      await expect.poll(() => pa.text.toJSON()).not.toBe(page);
      send(pa, pb);
      await shows(pb, pa.text.toJSON());
      b(pb);
      await expect.poll(() => pb.log.length).toBeGreaterThan(0);
      const main = merged(page, [pa, pb], [pa.log.length, pb.log.length]);
      await settle([pa, pb]);
      expect(pa.text.toJSON()).toBe(main);
      expect(pb.text.toJSON()).toBe(main);
    });
  }

  it('leaves alone a write a third person changed after it came', async () => {
    const page = 'Hello <mark data-color="red">world</mark> there.\n';
    const [a, b, c] = [await person(page, 3), await person(page, 1), await person(page, 2)];
    colour('world', 'highlight', 'blue')(a);
    typing('world', 0, 1, 'W')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    send(a, c);
    await shows(c, a.text.toJSON());
    // Its editor shows the blue highlight (#743: until it does, an edit writes the red one's text).
    await expect.poll(() => JSON.stringify(viewOf(c.dom).state.doc.toJSON())).toContain('blue');
    colour('world', 'highlight', null)(c);
    await expect.poll(() => c.log.length).toBe(1);
    const main = merged(page, [a, b, c], [1, 1, 1]);
    send(c, a);
    send(b, a);
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.text.toJSON()).toBe(main);
  });

  it('leaves alone a write someone changed in source mode after it came', async () => {
    const page = 'abcdefgh\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    const c = sourcePerson(page, 3);
    colour('abcdefgh', 'highlight', 'red')(a);
    typing('d', 0, 1, 'D')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    send(a, c);
    typeSource(c, c.text.toJSON().replace('red', 'blue'));
    const main = merged(page, [a, b, c], [1, 1, 1]);
    send(c, a);
    send(b, a);
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.text.toJSON()).toBe(main);
    expect(main).toContain('blue');
  });
});
