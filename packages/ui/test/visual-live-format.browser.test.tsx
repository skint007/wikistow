import { TextSelection } from '@milkdown/kit/prose/state';
import { act } from 'react';
import * as Y from 'yjs';
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
import { FORMATS } from '../src/page/editor/visual/formatting.ts';
import { BESIDE_MS } from '../src/page/editor/visual/live-rebase.ts';

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

  it('comes out as main does when a third person types in the word both format', async () => {
    const page = 'Say **world** now.\n';
    const people = [await person(page, 3), await person(page, 2), await person(page, 1)] as const;
    colour('world', 'highlight', 'red')(people[0]);
    colour('world', 'text', 'red')(people[1]);
    typing('world', 0, 1, 'W')(people[2]);
    typing('orld', 4, 0, 's')(people[2]);
    await expect.poll(() => people.map((p) => p.log.length)).toEqual([1, 1, 1]);
    const main = merged(page, [...people], [1, 1, 1]);
    await settle([...people]);
    for (const p of people) expect(p.text.toJSON()).toBe(main);
    expect(main).toContain('Worlds');
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

  // Typed where the write took markup out: Yjs places it after what was
  // taken out, so it was typed with the write in.
  const beside: [string, string, Edit][] = [
    ['typed before letters un-bolded', 'Say **world** now.\n', typing('wor', 0, 0, 'X')],
    ['a word typed before them', '**world** now.\n', typing('wor', 0, 0, 'The ')],
  ];
  for (const [name, page, b] of beside) {
    it(`leaves a change made after it as main does: ${name}`, async () => {
      const [pa, pb] = [await person(page, 2), await person(page, 1)];
      toggle('wor', 'bold')(pa);
      await expect.poll(() => pa.text.toJSON()).not.toBe(page);
      send(pa, pb);
      await shows(pb, pa.text.toJSON());
      // As a person typing after they see it: past `BESIDE_MS`.
      await new Promise((resolve) => setTimeout(resolve, BESIDE_MS));
      b(pb);
      await expect.poll(() => pb.log.length).toBeGreaterThan(0);
      const main = merged(page, [pa, pb], [pa.log.length, pb.log.length]);
      await settle([pa, pb]);
      expect(pa.text.toJSON()).toBe(main);
      expect(pb.text.toJSON()).toBe(main);
    });
  }

  it('comes out as main does when the same word is typed beside it', async () => {
    const page = 'Say **world** now.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    colour('world', 'highlight', 'red')(a);
    typing('world', 0, 0, 'world ')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('brings back nothing a third person took out that it took out too', async () => {
    const page = 'Say **==world==** now.\n';
    const a = await person(page, 3);
    const [b, c] = [sourcePerson(page, 2), sourcePerson(page, 1)];
    colour('world', 'highlight', 'red')(a);
    typeSource(b, page.replace('**==', 'world **=='));
    typeSource(c, page.replaceAll('==', ''));
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b, c], [1, 1, 1]);
    send(c, a);
    send(b, a);
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.text.toJSON()).toBe(main);
  });

  it('leaves alone a write someone typed inside, as literal text in code', async () => {
    const page = 'Say abcdefgh now.\n';
    const [a, b] = [await person(page, 3), await person(page, 2)];
    const c = sourcePerson(page, 1);
    toggle('abcdefgh', 'code')(a);
    typeSource(c, 'Say nice abcdefgh now.\n');
    await expect.poll(() => a.log.length).toBe(1);
    send(a, b);
    await shows(b, a.text.toJSON());
    typing('cdefgh', 0, 0, '**X**')(b);
    await expect.poll(() => b.log.length).toBe(1);
    const main = merged(page, [a, b, c], [1, 1, 1]);
    send(b, a);
    send(c, a);
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.text.toJSON()).toBe(main);
    expect(main).toContain('`ab');
  });

  it('leaves alone a write the person typed inside in the source pane', async () => {
    const page = 'Say abcdefgh now.\n';
    const a = await person(page, 2);
    const c = sourcePerson(page, 1);
    toggle('abcdefgh', 'code')(a);
    typeSource(c, 'Say nice abcdefgh now.\n');
    await expect.poll(() => a.log.length).toBe(1);
    typeSource(a, a.text.toJSON().replace('ab', 'ab**X**'));
    const main = merged(page, [a, c], [2, 1]);
    send(c, a);
    await settle([a, c]);
    for (const p of [a, c]) expect(p.text.toJSON()).toBe(main);
  });

  it('comes out as main does when a recoloured word is typed beside it', async () => {
    const page = 'Say ==world== now.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    colour('world', 'highlight', 'blue')(a);
    typing('world', 0, 0, 'world ')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  // Next to text it repeats, the characters it covers are found again by the
  // shared text's own identity, not by a diff of the text.
  const repeated: [string, string, Edit, Edit][] = [
    [
      'highlight, its first letter doubled',
      'Say wworld now.\n',
      colour('world', 'highlight', 'red'),
      typing('Say w', 4, 1, ''),
    ],
    [
      'bold, its first letter doubled',
      'Say wworld now.\n',
      toggle('world', 'bold'),
      typing('Say w', 4, 1, ''),
    ],
    [
      'code on a doubled word',
      'Run npm npm now.\n',
      (p) => {
        const view = viewOf(p.dom);
        const [from] = range(view.state.doc, 'npm now');
        act(() => {
          view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 3)),
          );
          FORMATS.code.run(view.state, view.dispatch);
        });
      },
      typing('Run npm', 4, 4, ''),
    ],
    [
      'bold on a doubled word',
      'It is very very good.\n',
      (p) => {
        const view = viewOf(p.dom);
        const [from] = range(view.state.doc, 'very good');
        act(() => {
          view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 4)),
          );
          FORMATS.bold.run(view.state, view.dispatch);
        });
      },
      typing('It is very', 6, 5, ''),
    ],
  ];
  for (const [name, page, a, b] of repeated) {
    it(`leaves a deletion made after it as main does: ${name}`, async () => {
      const [pa, pb] = [await person(page, 2), await person(page, 1)];
      a(pa);
      await expect.poll(() => pa.text.toJSON()).not.toBe(page);
      send(pa, pb);
      await shows(pb, pa.text.toJSON());
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      b(pb);
      await expect.poll(() => pb.log.length).toBeGreaterThan(0);
      const main = merged(page, [pa, pb], [pa.log.length, pb.log.length]);
      await settle([pa, pb]);
      expect(pa.text.toJSON()).toBe(main);
      expect(pb.text.toJSON()).toBe(main);
    });
  }

  for (const ids of ORDERS) {
    it(`comes out as main does: a letter typed before it that it starts with, clients ${ids.join(' and ')}`, async () => {
      const { end, main } = await together(
        'Hello world there.\n',
        [colour('world', 'highlight', 'red'), typing('world', 0, 0, 'w')],
        ids,
      );
      expect(raw(main)).toBe(false);
      expect(end).toBe(main);
    });
  }

  it('never makes code formatting again, as typing beside it would read otherwise', async () => {
    const page = 'Run npm now.\n';
    const a = await person(page, 2);
    const b = sourcePerson(page, 1);
    toggle('npm', 'code')(a);
    typeSource(b, 'Run npm&amp; now.\n');
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('leaves a deletion made after it as main does, after typing of theirs made alongside', async () => {
    const page = 'It is very very good.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    toggle('very good', 'bold')(a);
    typing('good.', 5, 0, ' Really.')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    send(b, a);
    send(a, b);
    await shows(b, a.text.toJSON());
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    typing('It is very', 6, 5, '')(b);
    await expect.poll(() => b.log.length).toBe(2);
    const main = merged(page, [a, b], [1, 2]);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('leaves a deletion made after it as main does, before typing of theirs elsewhere', async () => {
    const page = 'It is very very good.\n\nOther line here.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    toggle('very good', 'bold')(a);
    await expect.poll(() => a.log.length).toBe(1);
    send(a, b);
    await shows(b, a.text.toJSON());
    await new Promise((resolve) => setTimeout(resolve, 900));
    typing('It is very', 6, 5, '')(b);
    await expect.poll(() => b.log.length).toBe(1);
    send(b, a);
    await new Promise((resolve) => setTimeout(resolve, 800));
    typing('Other', 0, 0, 'new ')(b);
    await expect.poll(() => b.log.length).toBe(2);
    const main = merged(page, [a, b], [1, 2]);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('comes out as main does when typing of theirs made alongside came first', async () => {
    const page = 'world\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    typing('world', 5, 0, '!')(b);
    await expect.poll(() => b.log.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 850));
    colour('world', 'highlight', 'red')(a);
    colour('world!', 'text', 'red')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 2]);
    // B's two messages one after the other: the first, typing, made alongside
    // A's write, so the block's text isn't as A formatted it.
    const [first, second] = b.log;
    for (const update of [first, second]) {
      for (const listener of a.before)
        listener('them', { client: 1, update: update as Uint8Array });
      Y.applyUpdate(a.doc, update as Uint8Array, 'remote');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    b.sent.set(a, 2);
    const main = merged(page, [a, b], [1, 2]);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('comes out as main does: a phrase typed just after it', async () => {
    const page = 'Hello world there.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    colour('world', 'highlight', 'red')(a);
    typing('world', 5, 0, ', my friend')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('makes nothing again of a colour chosen again, which wrote nothing', async () => {
    const page = 'Say <mark data-color="red">world</mark>! now.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    colour('world', 'highlight', 'red')(a);
    await new Promise((resolve) => setTimeout(resolve, 875));
    colour('!', 'highlight', 'blue')(a);
    colour('world', 'highlight', 'plain')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('leaves typing after it as main does, beyond text taken out after it came', async () => {
    const page = 'Say world now.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    colour('world', 'highlight', 'red')(a);
    await expect.poll(() => a.log.length).toBe(1);
    send(a, b);
    await shows(b, a.text.toJSON());
    await new Promise((resolve) => setTimeout(resolve, 900));
    typing(' now.', 0, 4, '')(b);
    await expect.poll(() => b.log.length).toBe(1);
    send(b, a);
    await new Promise((resolve) => setTimeout(resolve, 300));
    typing('.', 0, 1, ', then.')(b);
    await expect.poll(() => b.log.length).toBe(2);
    const main = merged(page, [a, b], [1, 2]);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('leaves alone a write whose mark someone split after it came', async () => {
    const page = 'Say abcdefgh now.\n';
    const [a, b] = [await person(page, 3), await person(page, 2)];
    const c = sourcePerson(page, 1);
    colour('abcdefgh', 'highlight', 'red')(a);
    typeSource(c, 'Say abcdefgh! now.\n');
    await expect.poll(() => a.log.length).toBe(1);
    send(a, b);
    await shows(b, a.text.toJSON());
    await new Promise((resolve) => setTimeout(resolve, 900));
    colour('cde', 'highlight', 'blue')(b);
    await expect.poll(() => b.log.length).toBe(1);
    const main = merged(page, [a, b, c], [1, 1, 1]);
    send(b, a);
    send(c, a);
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.text.toJSON()).toBe(main);
  });

  for (const ids of ORDERS) {
    it(`comes out as main does where it's right: a highlight inside another, clients ${ids.join(' and ')}`, async () => {
      const { end, main } = await together(
        'Hello world there.\n',
        [colour('Hello', 'highlight', 'red'), colour('lo', 'highlight', 'blue')],
        ids,
      );
      // In one order Yjs crosses the tags, and that's made right; in the other, it nests them.
      if (raw(main)) expect(raw(end)).toBe(false);
      else expect(end).toBe(main);
    });
  }

  for (const [name, format, typed] of [
    ['bold', 'bold', '*'],
    ['italic', 'italic', '*'],
    ['bold', 'bold', '**'],
  ] as const) {
    it(`comes out as main does: ${typed} typed in source mode after a word made ${name}`, async () => {
      const page = 'Say world now.\n';
      const a = await person(page, 2);
      const b = sourcePerson(page, 1);
      toggle('world', format)(a);
      typeSource(b, page.replace('world', `world${typed}`));
      await expect.poll(() => a.log.length).toBe(1);
      const main = merged(page, [a, b], [1, 1]);
      send(b, a);
      send(a, b);
      await settle([a, b]);
      for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
    });
  }

  for (const ids of ORDERS) {
    for (const kind of ['highlight', 'text'] as const) {
      it(`comes out as main does: two ${kind} colours on one word, clients ${ids.join(' and ')}`, async () => {
        const { end, main } = await together(
          'Hello world there.\n',
          [colour('world', kind, 'red'), colour('world', kind, 'blue')],
          ids,
        );
        if (raw(main)) expect(raw(end)).toBe(false);
        else expect(end).toBe(main);
      });
    }
  }

  it('is made again over a change that came just before the editor took it in', async () => {
    const page = 'Say **world** now.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    colour('world', 'text', 'red')(b);
    await expect.poll(() => b.log.length).toBe(1);
    send(b, a);
    colour('world', 'highlight', 'red')(a);
    await settle([a, b]);
    const end = a.text.toJSON();
    expect(b.text.toJSON()).toBe(end);
    expect(raw(end)).toBe(false);
    expect(end).toContain('<span data-color="red">');
    expect(end).toContain('<mark data-color="red">');
  });

  it('never makes a link again, as both people may change its address', async () => {
    const page = '[world](https://example.test/one)\n';
    const a = await person(page, 2);
    const b = sourcePerson(page, 1);
    const view = viewOf(a.dom);
    act(() => {
      const { state } = view;
      const type = state.schema.marks['link'];
      const [from, to] = range(state.doc, 'world');
      const link = type?.isInSet(state.doc.nodeAt(from)?.marks ?? []);
      if (!type || !link) throw new Error('No link');
      view.dispatch(
        state.tr
          .removeMark(from, to, type)
          .addMark(from, to, type.create({ ...link.attrs, href: 'https://example.test/two' })),
      );
    });
    typeSource(b, '[world](https://example.test/one?x=y)\n');
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('comes out as main does with a link elsewhere on the page', async () => {
    const page = 'Say world now.\n\n[More](https://example.test)\n';
    const a = await person(page, 2);
    const b = sourcePerson(page, 1);
    toggle('world', 'bold')(a);
    typeSource(b, page.replace('world', 'world*'));
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  for (const order of ['theirs first', 'the recolour first'] as const) {
    it(`takes out no write of its own elsewhere: ${order}`, async () => {
      const page = 'Say **world** now.\n\nLook here.\n';
      const [a, b] = [await person(page, 3), await person(page, 2)];
      const c = sourcePerson(page, 1);
      colour('world', 'highlight', 'red')(a);
      colour('world', 'text', 'red')(b);
      await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      colour('here', 'highlight', 'red')(a);
      await expect.poll(() => a.log.length).toBe(2);
      send(a, c);
      await new Promise((resolve) => setTimeout(resolve, 900));
      typeSource(c, c.text.toJSON().replace('red">here', 'blue">here'));
      if (order === 'theirs first') {
        send(b, a);
        await new Promise((resolve) => setTimeout(resolve, 300));
        send(c, a);
      } else {
        send(c, a);
        await new Promise((resolve) => setTimeout(resolve, 300));
        send(b, a);
      }
      await settle([a, b, c]);
      const end = a.text.toJSON();
      for (const p of [b, c]) expect(p.text.toJSON()).toBe(end);
      expect(raw(end)).toBe(false);
      expect(end).toContain('Look <mark data-color="blue">here</mark>.');
    });
  }

  it('keeps the merge when their text, without its formatting, is one it can’t show', async () => {
    const page = 'A **bold _mixed_ run** here.\n';
    const [a, b, c] = [await person(page, 1), await person(page, 2), await person(page, 3)];
    typing('A', 0, 0, 'Q')(b);
    typing('A', 1, 0, ' A')(c);
    await expect.poll(() => [b, c].map((p) => p.log.length)).toEqual([1, 1]);
    send(b, a);
    send(c, a);
    // Before its editor takes theirs in.
    toggle('A', 'italic')(a);
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b, c], [1, 1, 1]);
    await settle([a, b, c]);
    for (const p of [a, b, c]) expect(p.text.toJSON()).toBe(main);
    expect(main).toContain('*A*');
  });

  it('looks at each write in turn when the first one’s merge reads right', async () => {
    const page = 'Say hello now.\n\nSay **world** now.\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    colour('hello', 'highlight', 'red')(a);
    typing('hello', 0, 1, 'H')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    await new Promise((resolve) => setTimeout(resolve, 320));
    colour('world', 'highlight', 'red')(a);
    colour('world', 'text', 'red')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([2, 2]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    const end = a.text.toJSON();
    expect(b.text.toJSON()).toBe(end);
    expect(raw(end)).toBe(false);
    expect(end).toContain('Say <mark data-color="red">Hello</mark> now.');
  });

  // From the final review of PR #745.
  for (const name of ['italic', 'bold', 'strike', 'highlight'] as const) {
    it(`comes out as main does: a letter changed beside a word made ${name}, after a bold taken off`, async () => {
      const page = 'Hello **world** there.\n';
      const [a, b] = [await person(page, 1), await person(page, 2)];
      toggle('world', 'bold')(a);
      toggle('Hello', name)(b);
      await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
      // Its bold taken off reaches the other, who takes it in, before it
      // has had theirs.
      send(a, b);
      await new Promise((resolve) => setTimeout(resolve, 300));
      typing('Hello', 4, 1, 'a')(a);
      await expect.poll(() => a.log.length).toBe(2);
      const main = merged(page, [a, b], [2, 1]);
      send(a, b);
      await settle([a, b]);
      for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
    });
  }

  it('comes out as main does: a letter changed beside a word struck, after its own highlight taken off', async () => {
    const page = 'Hello ==world== there.\n';
    const [a, b] = [await person(page, 1), await person(page, 2)];
    toggle('Hello', 'strike')(b);
    await expect.poll(() => b.log.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    colour('world', 'highlight', null)(b);
    await expect.poll(() => b.log.length).toBe(2);
    typing('Hello', 4, 1, 'a')(a);
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b], [1, 2]);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('comes out as main does: spaces typed in source mode that break an emphasis', async () => {
    const page = 'Say _world_ now.\n';
    const a = await person(page, 2);
    const b = sourcePerson(page, 1);
    colour('world', 'highlight', 'red')(a);
    typeSource(b, 'Say _  world_ now.\n');
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('takes out nothing while a word is composed, so closing the editor then loses nothing', async () => {
    const page = '**world**\n';
    const [a, b] = [await person(page, 2), await person(page, 1)];
    colour('world', 'highlight', 'red')(a);
    colour('world', 'text', 'red')(b);
    await expect.poll(() => [a, b].map((p) => p.log.length)).toEqual([1, 1]);
    const main = merged(page, [a, b], [1, 1]);
    send(a, b);
    const view = viewOf(a.dom);
    act(() => {
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    });
    act(() => void a.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' })));
    expect(view.composing).toBe(true);
    send(b, a);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Its editor closed while composing: the first one mounted.
    unmounts.shift()?.();
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
    expect(main).toContain('<mark data-color="red">');
  });

  it('reads as both people’s in a paragraph of 1 KB or more, checked at once', async () => {
    const page = `**world**${' [x](pg0.md)'.repeat(980)}\n`;
    const a = await person(page, 2);
    const b = sourcePerson(page, 1);
    colour('world', 'highlight', 'red')(a);
    typeSource(b, `<span data-color="red">**world**</span>${page.slice('**world**'.length)}`);
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b], [1, 1]);
    expect(raw(main)).toBe(true);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    const end = a.text.toJSON();
    expect(b.text.toJSON()).toBe(end);
    expect(raw(end)).toBe(false);
    expect(
      end.startsWith('<span data-color="red"><mark data-color="red">**world**</mark></span>'),
    ).toBe(true);
  });

  it('keeps the merge on a page of more than 16 KB', async () => {
    const page = `**world**${' [x](pg0.md)'.repeat(1_400)}\n`;
    const a = await person(page, 2);
    const b = sourcePerson(page, 1);
    colour('world', 'highlight', 'red')(a);
    typeSource(b, `<span data-color="red">**world**</span>${page.slice('**world**'.length)}`);
    await expect.poll(() => a.log.length).toBe(1);
    const main = merged(page, [a, b], [1, 1]);
    send(b, a);
    send(a, b);
    await settle([a, b]);
    for (const p of [a, b]) expect(p.text.toJSON()).toBe(main);
  });

  it('holds the page’s thread briefly on a long page of links', async () => {
    // About 15 KB, 1,200 links.
    const links = (i: number) => Array.from({ length: 10 }, () => `[x](p${i}.md)`).join(' ');
    const page = `**world** here.\n\n${Array.from({ length: 120 }, (_, i) => links(i)).join('\n\n')}\n`;
    const a = await person(page, 2);
    const b = sourcePerson(page, 1);
    colour('world', 'highlight', 'red')(a);
    typeSource(b, page.replace('**world**', '<span data-color="red">**world**</span>'));
    await expect.poll(() => a.log.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The longest the thread is held, as the longest gap between timers.
    let longest = 0;
    let last = performance.now();
    let ticking = true;
    const tick = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (ticking) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    send(b, a);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    ticking = false;
    await settle([a, b]);
    expect(b.text.toJSON()).toBe(a.text.toJSON());
    expect(raw(a.text.toJSON())).toBe(false);
    // About 0.15 s in Chromium here; before, 0.4 to 0.5 s.
    expect(longest).toBeLessThan(300);
  });
  // From the last review of PR #745, after which Scott narrowed it: a write is
  // made again only when both people's changes to the block are formatting
  // alone. Typing on either side merges as main does.
  it('comes out as main does: typing before a word highlighted, with a bold elsewhere', async () => {
    const page = 'foo *world* is big now.\n';
    const { end, main } = await together(
      page,
      [
        (p) => {
          toggle('now', 'bold')(p);
          typing('world', 0, 0, 'new ')(p);
        },
        colour('world', 'highlight', 'red'),
      ],
      [1, 2],
    );
    expect(main).toBe('foo new <mark data-color="red">*world*</mark> is big **now**.\n');
    expect(end).toBe(main);
  });

  it('comes out as main does: letters typed in source mode beside a word highlighted', async () => {
    const page = '**world**\n';
    const visual = await person(page, 2);
    const source = sourcePerson(page, 1);
    colour('world', 'highlight', 'red')(visual);
    typeSource(source, 'X**Yworld**\n');
    await expect.poll(() => visual.log.length).toBe(1);
    const main = merged(page, [visual, source], [1, 1]);
    expect(main).toBe('X<mark data-color="red">**Yworld**</mark>\n');
    send(source, visual);
    await settle([visual, source]);
    expect(source.text.toJSON()).toBe(visual.text.toJSON());
    expect(visual.text.toJSON()).toBe(main);
  });

  for (const ids of ORDERS) {
    it(`reads as both people’s between two paragraphs of 550 characters, clients ${ids.join(' and ')}`, async () => {
      const filler = `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')}.`;
      const page = `${filler}\n\n**world** here.\n\n${filler}\n`;
      const { end, main } = await together(
        page,
        [colour('world', 'highlight', 'red'), colour('world', 'text', 'red')],
        ids,
      );
      expect(raw(main)).toBe(true);
      expect(raw(end)).toBe(false);
      expect(end).toContain('<span data-color="red">');
      expect(end).toContain('<mark data-color="red">');
    });
  }

  it('holds the page’s thread briefly when a word is capitalised beside each of many highlights', async () => {
    const words = Array.from({ length: 8 }, (_, i) => `world${i}`);
    const links = Array.from({ length: 120 }, (_, i) =>
      Array.from({ length: 10 }, () => `[x](p${i}.md)`).join(' '),
    );
    const page = `${[...words.map((word) => `${word} here.`), 'spacer.', ...links].join('\n\n')}\n`;
    const visual = await person(page, 2);
    const source = sourcePerson(page, 1);
    for (const [i, word] of words.entries()) {
      colour(word, 'highlight', 'red')(visual);
      await expect.poll(() => visual.log.length).toBe(i + 1);
    }
    await expect.poll(() => visual.handle.read()).toBe(visual.text.toJSON());
    typeSource(source, page.replaceAll('world', 'World'));
    const main = merged(page, [visual, source], [words.length, 1]);
    // The longest the thread is held, as the longest gap between timers.
    let longest = 0;
    let last = performance.now();
    let ticking = true;
    const tick = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (ticking) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    send(source, visual);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    ticking = false;
    await settle([visual, source]);
    expect(source.text.toJSON()).toBe(main);
    expect(visual.text.toJSON()).toBe(main);
    expect(longest).toBeLessThan(100);
  }, 20_000);
});
