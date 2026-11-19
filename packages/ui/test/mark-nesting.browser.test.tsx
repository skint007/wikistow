import type { Mark, Node } from '@milkdown/kit/prose/model';
import { Transform } from '@milkdown/kit/prose/transform';
import { describe, expect, it } from 'vite-plus/test';
import { loadSyntaxNodes, transformer } from '../src/page/editor/visual/config.ts';
import { fidelityOf, writesAsShown } from '../src/page/editor/visual/fidelity.ts';
import { meaningOf } from '../src/page/editor/visual/reader-fidelity.ts';

// Marks that overlap only partly (#437): the visual editor may write them
// nested one way, and the same text read back the other, so the fidelity
// check reads each run of text by the marks on it, not by how they nest.
// Seeded, so a failure names what reproduces it: the seed
// (`VITE_FUZZ_SEED` picks another), the page and each edit.

const SEED = Number(import.meta.env['VITE_FUZZ_SEED'] ?? 20_261_118);

/** mulberry32: small, fast and the same everywhere. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const below = (n: number) => Math.floor(next() * n);
  const pick = <T,>(items: readonly T[]): T => {
    const item = items[below(items.length)];
    if (item === undefined) throw new Error('Nothing to pick');
    return item;
  };
  return { below, pick };
}

const PAGES = [
  'abc def ghi\n',
  'a b c d e f\n',
  'one two three four\n',
  'x y\n',
  'ab cd ef gh ij\n',
];
// Not code: a mark starting at a space in it parts the code span as written (#658).
const MARKS = ['strong', 'emphasis', 'strike_through', 'link'];
const COLOURED = [...MARKS, 'highlight', 'highlight', 'text_color'];

const attrsFor = (name: string, rng: ReturnType<typeof random>) =>
  name === 'link'
    ? { href: `https://example.test/${rng.below(2)}` }
    : name === 'text_color'
      ? { color: rng.pick(['red', 'blue']) }
      : name === 'highlight'
        ? { color: rng.pick([null, null, 'red']) }
        : null;

describe('marks that overlap partly', () => {
  it(
    'open again in the visual editor once written, after random mark edits',
    { timeout: 120_000 },
    async () => {
      await loadSyntaxNodes();
      const t = await transformer();
      const rng = random(SEED);
      let checked = 0;
      for (const names of [MARKS, COLOURED]) {
        for (let round = 0; round < 750; round++) {
          const page = rng.pick(PAGES);
          let doc: Node = t.parse(page);
          const done: string[] = [];
          for (let edit = 0; edit < 6; edit++) {
            const size = doc.content.size;
            const from = 1 + rng.below(size - 2);
            const to = Math.min(size - 1, from + 1 + rng.below(6));
            const name = rng.pick(names);
            const type = doc.type.schema.marks[name];
            if (!type) throw new Error(`No mark ${name}`);
            const mark: Mark = type.create(attrsFor(name, rng));
            const removes = rng.below(4) === 0;
            const tr = new Transform(doc);
            doc = (removes ? tr.removeMark(from, to, type) : tr.addMark(from, to, mark)).doc;
            done.push(
              `${removes ? 'remove' : 'add'} ${JSON.stringify(mark.toJSON())} ${from}–${to}`,
            );
            const written = t.serialize(doc);
            // What the guard gives up isn't written.
            if (!writesAsShown(doc, written, t.parse)) continue;
            checked++;
            const where = `seed ${SEED}, ${JSON.stringify(page)}, after:\n${done.join('\n')}\nwrote ${JSON.stringify(written)}, then ${JSON.stringify(t.serialize(t.parse(written)))}`;
            expect(fidelityOf(written, t), where).toEqual({ visual: true });
          }
        }
      }
      expect(checked).toBeGreaterThan(8_000);
    },
  );

  it('open again as the editor wrote them', async () => {
    await loadSyntaxNodes();
    const t = await transformer();
    for (const page of [
      // Bold inside strike, around escaped tildes (#437).
      '~~**d\\~\\~**\\~\\~d~~\n',
      // Strike on a space between two runs of emphasis, which Milkdown writes off it.
      '[a b ~~c~~](https://example.test/0) ~~*d* e~~ f\n',
      'a **b c ~~d~~** ~~*e* f~~\n',
      // A highlight in two parts, written again as one.
      'ab ==cd e*f*== *~~gh i~~*~~j~~\n',
      'ab[c **def**](https://example.test/1) **==g==**==hi==\n',
      // A colour in two parts with a highlight between, written again as one.
      'one ==<span data-color="blue">th</span>==<span data-color="blue">ree</span> four\n',
    ])
      expect(fidelityOf(page, t), page).toEqual({ visual: true });
  });

  it('read the same however the marks nest', () => {
    for (const [a, b] of [
      ['~~*d* e~~\n', '*~~d~~* ~~e~~\n'],
      ['**a *b*** *c*\n', '**a** ***b** c*\n'],
      ['==**a**==\n', '**==a==**\n'],
      ['[==a==](u)\n', '==[a](u)==\n'],
      ['[**a**](u)[b](u)\n', '**[a](u)**[b](u)\n'],
      ['*==gh==*==x==\n', '==*gh*x==\n'],
      // A colour in two parts, one only a space, and a mark the editor drops around one.
      [
        '*<span data-color="red">d</span>*<span data-color="red"> </span>f\n',
        '<span data-color="red">*d* </span>f\n',
      ],
      ['**<span data-color="blue"> </span>**\n', '<span data-color="blue"> </span>\n'],
      // A mark inside one the same.
      ['**a __b__ c**\n', '**a b c**\n'],
      [
        '<span data-color="red">a</span><span data-color="red">b</span>\n',
        '<span data-color="red">ab</span>\n',
      ],
    ] as const)
      expect(meaningOf(a), `${a} and ${b}`).toBe(meaningOf(b));
  });

  it('still read marks moved, links parted, and text changed as different', () => {
    for (const [a, b] of [
      // One link written as two, and two as one.
      ['[ab](u)\n', '[a](u)[b](u)\n'],
      ['[a](u) [b](u)\n', '[a b](u)\n'],
      ['**a** b\n', 'a **b**\n'],
      ['~~a~~ b\n', '~~a b~~\n'],
      ['*a*\n', '**a**\n'],
      ['`a`\n', 'a\n'],
      ['[a](u)\n', '[a](v)\n'],
      ['==a==\n', '<mark data-color="red">a</mark>\n'],
      ['<span data-color="red">a</span>\n', '<span data-color="blue">a</span>\n'],
      ['**a**\n', '**b**\n'],
      ['a b\n', 'a  b\n'],
      ['**a**\\\n**b**\n', '**a b**\n'],
      ['**![x](i)**\n', '![x](i)\n'],
      ['x[](u)\n', 'x\n'],
      // A link around only a space, as Milkdown writes it without one.
      ['x[ ](u)y\n', 'x y\n'],
      ['x **[ ](u)** y\n', 'x   y\n'],
      // Code spans side by side aren't one, nor one two.
      [
        '<span data-color="red">`=servings`</span><span data-color="red">`2`</span>\n',
        '<span data-color="red">`=servings2`</span>\n',
      ],
      ['`a b`\n', '`a` `b`\n'],
      ['x ~~` `~~ y\n', 'x ` ` y\n'],
      // HTML in marks, which may close in another than it opens in.
      ['*<sub>a****b</sub>* c**\n', '*<sub>a**b</sub>*** **c**\n'],
    ] as const)
      expect(meaningOf(a), `${a} and ${b}`).not.toBe(meaningOf(b));
  });

  it('read a link’s title the same in either line break', () => {
    expect(meaningOf('x\r\n\r\n[a](u "a\r\nb")\r\n')).toBe(meaningOf('x\n\n[a](u "a\nb")\n'));
  });

  it('name each mark once however many words it is on', () => {
    const title = 't'.repeat(16_384);
    const words = Array.from({ length: 2_048 }, (_, i) => (i % 2 ? `**w${i}**` : `w${i}`));
    const page = `[${words.join(' ')}](u "${title}")\n`;
    expect(meaningOf(page).length).toBeLessThan(page.length * 4);
    // Nor a mark inside one the same, for each.
    const red = (depth: number) =>
      `${'<span data-color="red">'.repeat(depth)}${words.join(' ')}${'</span>'.repeat(depth)}\n`;
    expect(meaningOf(red(256)).length).toBe(meaningOf(red(1)).length);
  });
});
