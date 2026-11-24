import { afterEach, describe, expect, it } from 'vite-plus/test';
import * as Y from 'yjs';
import { ownChanges, putInto } from '../src/page/editor/visual/live-text.ts';
import {
  colour,
  LOCAL,
  person,
  raw,
  settle,
  together,
  toggle,
  typing,
  unmounts,
  type Edit,
  type Person,
} from './live-format-people.tsx';

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
    const first = new Y.Doc();
    first.clientID = 1_000_000;
    first.getText('body').insert(0, page);
    const doc = new Y.Doc();
    doc.clientID = 1;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(first));
    const log: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) log.push(update);
    });
    const typed = '<span data-color="red">**world**</span>\n';
    doc.transact(() => putInto(doc.getText('body'), ownChanges(page, typed)), LOCAL);
    const b = {
      doc,
      text: doc.getText('body'),
      before: new Set(),
      log,
      sent: new Map(),
    } as unknown as Person;
    colour('world', 'highlight', 'red')(a);
    await expect.poll(() => a.text.toJSON()).not.toBe(page);
    await settle([a, b]);
    expect(a.text.toJSON()).toBe(
      '<span data-color="red"><mark data-color="red">**world**</mark></span>\n',
    );
    expect(b.text.toJSON()).toBe(a.text.toJSON());
  });
});
