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
  'a b\\\nc d e\n',
  'a ` b ` c d\n',
  'ab  cd ef\n',
  // No-break spaces, which no delimiter can sit beside (#730).
  'a b\u00a0c d\n',
  'ab\u00a0\u00a0cd ef\n',
  'a b\u00a0\\\nc d\n',
  'a\u00a0b\\\n\u00a0c d e\n',
];
const MARKS = ['strong', 'emphasis', 'strike_through', 'link', 'inlineCode'];
const COLOURED = [...MARKS, 'highlight', 'highlight', 'text_color'];

type Edit = readonly [string, number, number, Record<string, string>?];

/** That `page` with `marks` added in turn is written as `wrote`, and opens again as shown. */
async function writes(page: string, marks: readonly Edit[], wrote: string) {
  await loadSyntaxNodes();
  const t = await transformer();
  let doc: Node = t.parse(page);
  for (const [name, from, to, attrs] of marks) {
    const type = doc.type.schema.marks[name];
    if (!type) throw new Error(`No mark ${name}`);
    doc = new Transform(doc).addMark(from, to, type.create(attrs)).doc;
  }
  const written = t.serialize(doc);
  expect(written, page).toBe(wrote);
  expect(writesAsShown(doc, written, t.parse), written).toBe(true);
  expect(t.serialize(t.parse(written)), written).toBe(written);
  expect(fidelityOf(written, t), written).toEqual({ visual: true });
}

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
      const rejected: string[] = [];
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
            const where = `seed ${SEED}, ${JSON.stringify(page)}, after:\n${done.join('\n')}\nwrote ${JSON.stringify(written)}, then ${JSON.stringify(t.serialize(t.parse(written)))}`;
            // What the guard gives up isn't written, but sends the page to source mode.
            if (!writesAsShown(doc, written, t.parse)) {
              rejected.push(where);
              continue;
            }
            checked++;
            expect(fidelityOf(written, t), where).toEqual({ visual: true });
          }
        }
      }
      expect(rejected).toEqual([]);
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

  it('keep the marks on spaces in code, as written', async () => {
    await loadSyntaxNodes();
    const t = await transformer();
    for (const [page, marks, wrote] of [
      // Code from a space on, which bold took off before, parting the code (#658).
      [
        'a b c d e f\n',
        [
          ['inlineCode', 8, 12],
          ['strong', 6, 9],
          ['emphasis', 5, 8],
          ['emphasis', 10, 12],
          ['strong', 9, 12],
        ],
        'a b *c **d***__` e`*` f`*__\n',
      ],
      // Bold over ` e` in the code ` e `. Remark writes the letter before as a
      // reference, so the `**` before a backtick opens bold, as for any code.
      [
        'x e f\n',
        [
          ['inlineCode', 2, 5],
          ['strong', 2, 4],
        ],
        '&#x78;**` e`**` `f\n',
      ],
      // Spaces before code still go out of the mark.
      [
        'x a  b\n',
        [
          ['inlineCode', 5, 7],
          ['strong', 4, 7],
        ],
        'x a **` b`**\n',
      ],
      // A line break code was put on, which code can't hold, so it leaves the link.
      [
        'x\\\ny\n',
        [
          ['link', 2, 3, { href: 'u' }],
          ['inlineCode', 2, 3],
        ],
        'x\\\ny\n',
      ],
    ] as const) {
      await writes(page, marks, wrote);
    }
    // As the editor wrote the first before, which it parted again on writing it.
    expect(fidelityOf('a b *c **d***__`  e  `*`f`*__\n', t)).toEqual({ visual: true });
  });

  it('write a line break out of a mark ended before a link (#682)', async () => {
    // Bold over `b`, the break and `c d`, then a link from `c` on past it,
    // which the bold ends before: the break goes out of the bold, as a
    // delimiter after one doesn't close it.
    await writes(
      'a b\\\nc d e\n',
      [
        ['strong', 3, 8],
        ['link', 5, 10, { href: 'u' }],
      ],
      'a **b**\\\n[**c d** e](u)\n',
    );
    // Bold opened again after a link it went on past, from the break on.
    await writes(
      'a b\\\nc d e\n',
      [
        ['link', 1, 4, { href: 'u' }],
        ['strong', 3, 8],
      ],
      '[a **b**](u)\\\n**c d** e\n',
    );
    // But not where the mark would then start beside a no-break space,
    // which keeps it once the break is before it, as no delimiter can sit
    // beside one; nor out of a colour's HTML around one, which a mark
    // around the colour would then end beside.
    await writes(
      'a b\\\n\u00a0c d e\n',
      [
        ['link', 1, 4, { href: 'u' }],
        ['strong', 3, 7],
      ],
      '[a **b**](u)**\\\n\u00a0c** d e\n',
    );
    await writes(
      'a <span data-color="red">b\u00a0\\\nc d</span> e\n',
      [['link', 6, 11, { href: 'u' }]],
      'a <span data-color="red">b\u00a0\\\n</span>[<span data-color="red">c d</span> e](u)\n',
    );
    await writes(
      'a <span data-color="red">b\u00a0\\\nc d</span> e\n',
      [
        ['strong', 1, 7],
        ['link', 6, 11, { href: 'u' }],
      ],
      '**a <span data-color="red">b\u00a0\\\n</span>**[<span data-color="red">**c** d</span> e](u)\n',
    );
    // A colour's HTML keeps a no-break space at its end, which Milkdown leaves in.
    await writes(
      'a <span data-color="red">b\u00a0</span> e\n',
      [],
      'a <span data-color="red">b\u00a0</span> e\n',
    );
  });

  it('write a no-break space at a mark’s end out of it (#730)', async () => {
    // Bold over `b` and the no-break space, then a link over `c d`.
    await writes(
      'a b\u00a0c d\n',
      [
        ['strong', 3, 5],
        ['link', 5, 8, { href: 'u' }],
      ],
      'a **b**\u00a0[c d](u)\n',
    );
    await writes('a b\u00a0c d\n', [['strong', 3, 5]], 'a **b**\u00a0c d\n');
    await writes('a b\u00a0c d\n', [['emphasis', 4, 6]], 'a b\u00a0*c* d\n');
    await writes('a b\u00a0c d\n', [['strike_through', 4, 7]], 'a b\u00a0~~c~~ d\n');
    // Before a line break.
    await writes('a b\u00a0\\\nc d\n', [['strong', 3, 6]], 'a **b**\u00a0\\\nc d\n');
    // Strikethrough from a line break on keeps the no-break space after it.
    await writes(
      'a b\\\n\u00a0c d e\n',
      [
        ['link', 1, 4, { href: 'u' }],
        ['strike_through', 3, 7],
      ],
      '[a ~~b~~](u)~~\\\n\u00a0c~~ d e\n',
    );
    // A colour keeps a no-break space before a line break at its end, as
    // it does at its end; an ASCII space goes out with the break.
    await writes(
      'a <mark data-color="red">b\u00a0\\\n</mark>c\n',
      [['strong', 1, 2]],
      '**a** <mark data-color="red">b\u00a0</mark>\\\nc\n',
    );
    await writes(
      'a <mark data-color="red">b \\\n</mark>c\n',
      [['strong', 1, 2]],
      '**a** <mark data-color="red">b</mark> \\\nc\n',
    );
    // Inside the bold, it stays.
    await writes('a b\u00a0\\\nc d\n', [['strong', 3, 7]], 'a **b\u00a0\\\nc** d\n');
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
      // A no-break space shows no marks, as a space doesn't.
      ['**a**\u00a0**b**\n', '**a\u00a0b**\n'],
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
      ['a b\n', 'a\u00a0b\n'],
      ['a\u00a0\n', 'a\n'],
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
