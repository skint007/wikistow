import { describe, expect, it } from 'vite-plus/test';
import {
  canonical,
  estimateTokens,
  generateIdentity,
  IdentityId,
  indexedContent,
  InstallationId,
  meaningBytes,
  meaningPassages,
  nearestPages,
  openMeaningIndex,
  passageHash,
  quantizeVector,
  readMeaningBytes,
  reducedText,
  RevisionId,
  sealMeaningIndex,
  searchText,
  MEANING_PASSAGES_VERSION,
  type KeptMeaning,
  type MeaningPassage,
  type Vector8,
} from '../src/index.ts';
import { sealOnDevice } from '../src/device-seal.ts';

// A token a word, so budgets read plainly here.
const words = (word: string) => (word ? 1 : 0);

/** Each passage's text and start, as `meaningPassages` cuts `markdown` with `title`. */
function cut(title: string, markdown: string, maxTokens = 8) {
  const { text, headings } = reducedText(markdown);
  return meaningPassages({ title, text, headings }, { maxTokens, countTokens: words }).map(
    ({ text: passage, start, heading }) => ({ passage, start, heading }),
  );
}

describe('the reduction’s headings', () => {
  it('marks where each heading of the page starts in its text', () => {
    const markdown = '# Lasagne\n\nIntro line\nwraps here\n\n## Method\n\nBoil.';
    const { text, headings } = reducedText(markdown);
    expect(text).toBe('Lasagne\nIntro line wraps here\nMethod\nBoil.');
    expect(text).toBe(searchText(markdown));
    expect(headings.map((at) => text.slice(at).split('\n')[0])).toEqual(['Lasagne', 'Method']);
  });

  it('marks setext headings, but not a heading in a quote or list item, or a rule', () => {
    const markdown =
      'Title\n=====\n\nOne\nlong\n---\n\n> # Quoted\n\n- # Listed\n\nA rule\n\n***\n\n- - -\n\nEnd';
    const { text, headings } = reducedText(markdown);
    expect(headings.map((at) => text.slice(at).split('\n')[0])).toEqual(['Title', 'One long']);
    expect(reducedText('Foo\n-\n\ntext').headings).toEqual([0]);
  });

  it('marks nothing in the frontmatter, whatever its line breaks', () => {
    expect(reducedText('---\n# a comment\ntitle: x\n---\nBody').headings).toEqual([]);
    expect(reducedText('---\ntitle: a\rb\n---\nBody').headings).toEqual([]);
    expect(reducedText('---\r\ntitle: a\r\n---\r\n# Body').headings).toEqual(['title: a\n'.length]);
  });

  it('marks no heading without text', () => {
    expect(reducedText('#\ntext').headings).toEqual([]);
    expect(reducedText('#\n\n# Real').headings).toEqual(['#\n'.length]);
  });

  it('marks a heading cut short, but nothing past the text it keeps, nor an empty heading', () => {
    const { text, headings } = reducedText('## \n\nIntro\n\n# Cut off', { limit: 8 });
    expect(text).toBe('Intro\nCu');
    expect(headings).toEqual([6]);
    expect(reducedText('Intro\n\n# Cut off', { limit: 6 })).toEqual({
      text: 'Intro',
      headings: [],
    });
  });

  it('are what the index keeps of a page beside its text', () => {
    expect(indexedContent('Intro\n\n# Next\n\ntext').headings).toEqual([6]);
  });
});

describe('a page’s passages', () => {
  it('is the title and whole text for a page that fits in one', () => {
    expect(cut('Lasagne', '# Ingredients\n\nPasta.\n\n# Method\n\nBake.', 16)).toEqual([
      { passage: 'Lasagne\nIngredients\nPasta.\nMethod\nBake.', start: 0, heading: null },
    ]);
  });

  it('is the title alone for a page with no text, and nothing with no title either', () => {
    expect(cut('Lasagne', '')).toEqual([{ passage: 'Lasagne', start: 0, heading: null }]);
    expect(cut('', '')).toEqual([]);
  });

  it('cuts a longer page at its headings, each passage with its title and heading', () => {
    const markdown =
      'Our family dish.\n\n## Ingredients\n\nPasta, sauce.\n\n## Method\n\nLayer and bake.';
    const { text } = reducedText(markdown);
    expect(cut('Lasagne', markdown)).toEqual([
      { passage: 'Lasagne\nOur family dish.', start: 0, heading: null },
      {
        passage: 'Lasagne\nIngredients\nPasta, sauce.',
        start: text.indexOf('Pasta'),
        heading: 'Ingredients',
      },
      {
        passage: 'Lasagne\nMethod\nLayer and bake.',
        start: text.indexOf('Layer'),
        heading: 'Method',
      },
    ]);
  });

  it('gives a heading with nothing under it a passage of its own, where it starts', () => {
    const markdown = '## Notes\n\n## Method\n\nLayer and bake it.';
    expect(cut('Lasagne', markdown, 6)).toEqual([
      { passage: 'Lasagne\nNotes', start: 0, heading: 'Notes' },
      {
        passage: 'Lasagne\nMethod\nLayer and bake it.',
        start: 'Notes\nMethod\n'.length,
        heading: 'Method',
      },
    ]);
  });

  it('cuts a longer section at paragraphs, each passage as long as it can be', () => {
    // Six tokens for text after the title and heading.
    const markdown =
      '# Method\n\nBoil the pasta.\n\nMake the sauce.\n\nLayer.\n\nBake for an hour.';
    expect(cut('Lasagne', markdown).map(({ passage }) => passage)).toEqual([
      'Lasagne\nMethod\nBoil the pasta.\nMake the sauce.',
      'Lasagne\nMethod\nLayer.\nBake for an hour.',
    ]);
  });

  it('cuts a longer paragraph between words, and a longer word between characters', () => {
    const paragraph = 'one two three four five six seven eight nine ten';
    expect(cut('T', `${paragraph}\n\n# Next\n\nx`).map(({ passage }) => passage)).toEqual([
      'T\none two three four five six seven',
      'T\neight nine ten',
      'T\nNext\nx',
    ]);
    const long = 'a'.repeat(20);
    const pieces = meaningPassages(
      { title: 'T', text: long, headings: [] },
      // A token a character.
      { maxTokens: 8, countTokens: (word) => word.length },
    );
    expect(pieces.map(({ text, start }) => [text, start])).toEqual([
      ['T\naaaaaaa', 0],
      ['T\naaaaaaa', 7],
      ['T\naaaaaa', 14],
    ]);
  });

  it('keeps the pieces of a word it cut apart, as its tokens aren’t theirs added up', () => {
    // A token a word up to 10 characters, and one a character past that.
    const countTokens = (word: string) => (word.length > 10 ? word.length : 1);
    const pieces = meaningPassages(
      { title: 'T', text: 'a'.repeat(12), headings: [] },
      { maxTokens: 8, countTokens },
    );
    expect(pieces.map(({ text }) => text)).toEqual([`T\n${'a'.repeat(10)}`, 'T\naa']);
  });

  it('cuts a title longer than half a passage to half of one', () => {
    const title = 'one two three four five six';
    expect(cut(title, 'Body text here.\n\n# Next\n\nMore.').map(({ passage }) => passage)).toEqual([
      'one two three four\nBody text here.',
      'one two three four\nNext\nMore.',
    ]);
  });

  it('keeps each passage within the budget, counting its title and heading', () => {
    const markdown = Array.from(
      { length: 30 },
      (_, i) => `## Part ${i}\n\n${'word '.repeat(i * 3)}end.\n\nShort one.`,
    ).join('\n\n');
    const { text, headings } = reducedText(markdown);
    const passages = meaningPassages(
      { title: 'A long page', text, headings },
      { maxTokens: 24, countTokens: words },
    );
    expect(passages.length).toBeGreaterThan(30);
    for (const { text: passage } of passages) {
      expect(passage.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(24);
    }
  });

  it('counts tokens the way the model’s tokenizer splits words, or more', () => {
    expect(estimateTokens('the')).toBe(1);
    expect(estimateTokens('pasta,')).toBe(2);
    expect(estimateTokens('Café')).toBe(1);
    expect(estimateTokens('3.14')).toBe(4);
    expect(estimateTokens('日本語')).toBe(3);
    expect(estimateTokens('lasagne')).toBeGreaterThanOrEqual(2);
    expect(estimateTokens('')).toBe(0);
    // What doesn't read as a word, one a character: no token is shorter.
    // The model's tokenizer makes 6, 9, 27 and 54 of these.
    expect(estimateTokens('1234567890')).toBe(10);
    expect(estimateTokens('qxjzvkwpmb')).toBe(10);
    expect(estimateTokens('aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQ=')).toBe(36);
    expect(estimateTokens(`sha256:${'0a'.repeat(32)}`)).toBe(71);
    expect(estimateTokens('iPhone')).toBe(6);
    expect(estimateTokens('a'.repeat(10) + 'e'.repeat(10))).toBe(5);
    expect(estimateTokens('a'.repeat(21))).toBe(21);
    expect(estimateTokens('Pneumonoultramicroscopicsilicovolcanoconiosis')).toBe(45);
  });

  it('cuts at 256 tokens by default', () => {
    const text = Array.from({ length: 300 }, () => 'the').join(' ');
    const [first, second] = meaningPassages({ title: 'T', text, headings: [] });
    expect(first?.text.split(' ').length).toBe(255);
    expect(second?.start).toBe(255 * 4);
  });

  it('hashes each passage by its text', () => {
    const [passage] = cut('Lasagne', 'Bake it.');
    const again = meaningPassages({ title: 'Lasagne', text: 'Bake it.', headings: [] });
    expect(again[0]?.hash).toBe(passageHash('Lasagne\nBake it.'));
    expect(passageHash('Lasagne\nBake it!')).not.toBe(again[0]?.hash);
    expect(passage?.passage).toBe('Lasagne\nBake it.');
  });
});

/** A unit vector along `axes`, in `dimensions`. */
function unit(dimensions: number, axes: Record<number, number>): Float32Array {
  const vector = new Float32Array(dimensions);
  for (const [axis, value] of Object.entries(axes)) vector[Number(axis)] = value;
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

describe('vectors of 8 bits', () => {
  it('keeps each value as a signed byte with one scale', () => {
    const { scale, values } = quantizeVector([0.5, -1, 0.25, 0]);
    expect([...values]).toEqual([64, -127, 32, 0]);
    expect(scale).toBe(Math.fround(1 / 127));
  });

  it('rounds halves away from zero', () => {
    expect([...quantizeVector([-0.5, 1, 0.5]).values]).toEqual([-64, 127, 64]);
  });

  it('keeps a vector of zeros as zeros', () => {
    expect(quantizeVector([0, 0])).toEqual({ scale: 0, values: new Int8Array(2) });
  });

  it('refuses a value that isn’t a number', () => {
    expect(() => quantizeVector([0.5, Number.NaN])).toThrow();
    expect(() => quantizeVector([Number.POSITIVE_INFINITY])).toThrow();
  });

  it('stay close to the vector they came from', () => {
    const vector = unit(
      384,
      Object.fromEntries(Array.from({ length: 384 }, (_, i) => [i, Math.sin(i)])),
    );
    const { scale, values } = quantizeVector(vector);
    const error = Math.max(...vector.map((value, i) => Math.abs(value - values[i]! * scale)));
    expect(error).toBeLessThanOrEqual(scale / 2 + 1e-7);
  });
});

describe('the nearest pages', () => {
  const passage = (axes: Record<number, number>) => ({ vector: quantizeVector(unit(4, axes)) });
  const pages: [string, { vector: Vector8 }[]][] = [
    ['beach', [passage({ 0: 1 }), passage({ 1: 1 })]],
    ['boiler', [passage({ 2: 1 })]],
    ['coast', [passage({ 0: 1, 1: 1 })]],
    ['empty', []],
  ];

  it('ranks each page by its best passage, best first, as many as asked for', () => {
    const query = unit(4, { 0: 1, 1: 0.1 });
    const nearest = nearestPages(query, pages, 2);
    expect(nearest.map(({ key, passage: at }) => [key, at])).toEqual([
      ['beach', 0],
      ['coast', 0],
    ]);
    expect(nearest[0]?.score).toBeCloseTo(Math.cos(Math.atan(0.1)), 2);
    expect(nearestPages(query, pages, 10).map(({ key }) => key)).toEqual([
      'beach',
      'coast',
      'boiler',
    ]);
  });

  it('scores by cosine, whatever the query’s length', () => {
    const [best] = nearestPages(new Float32Array([0, 0, 5, 0]), pages, 1);
    expect(best?.key).toBe('boiler');
    expect(best?.score).toBeCloseTo(1, 2);
  });

  it('finds nothing for a query of zeros, or none asked for', () => {
    expect(nearestPages(new Float32Array(4), pages, 3)).toEqual([]);
    expect(nearestPages(unit(4, { 0: 1 }), pages, 0)).toEqual([]);
  });

  it('refuses a query of another length than the vectors', () => {
    expect(() => nearestPages(new Float32Array(3).fill(1), pages, 3)).toThrow();
  });
});

describe('the kept vectors', () => {
  const installationId = InstallationId.parse('test-installation');
  const identity = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' });
  const keeper = { installationId, identity };
  const model = 'a'.repeat(64);
  const passage = (text: string, start: number, axes: Record<number, number>): MeaningPassage => ({
    hash: passageHash(text),
    start,
    vector: quantizeVector(unit(4, axes)),
  });
  const kept: KeptMeaning = new Map([
    [RevisionId.parse('soup-r1'), [passage('Soup\nHot.', 0, { 0: 1 }), passage('B', 9, { 1: -1 })]],
    [RevisionId.parse('empty-r1'), []],
  ]);

  it('opens as they were sealed, for this person, installation and model', () => {
    const sealed = sealMeaningIndex(keeper, kept, model);
    expect(openMeaningIndex(keeper, sealed, model)).toEqual(kept);
    expect(openMeaningIndex(keeper, sealed, 'b'.repeat(64))).toBeNull();
    const other = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' });
    expect(openMeaningIndex({ installationId, identity: other }, sealed, model)).toBeNull();
    const elsewhere = { installationId: InstallationId.parse('elsewhere'), identity };
    expect(openMeaningIndex(elsewhere, sealed, model)).toBeNull();
  });

  it('opens as nothing when sealed under the word index’s domains', () => {
    const plaintext = meaningBytes(kept);
    const ad = canonical('search-index/v1', [installationId, identity.public.id, model]);
    const sealed = sealOnDevice(identity, 'search-index-key/v1', ad, plaintext);
    expect(openMeaningIndex(keeper, sealed, model)).toBeNull();
    const bound = canonical('meaning-index/v1', [
      installationId,
      identity.public.id,
      model,
      MEANING_PASSAGES_VERSION,
    ]);
    expect(
      openMeaningIndex(
        keeper,
        sealOnDevice(identity, 'meaning-index-key/v1', bound, plaintext),
        model,
      ),
    ).toEqual(kept);
    expect(
      openMeaningIndex(
        keeper,
        sealOnDevice(
          identity,
          'meaning-index-key/v1',
          canonical('meaning-index/v1', [
            installationId,
            identity.public.id,
            model,
            MEANING_PASSAGES_VERSION + 1,
          ]),
          plaintext,
        ),
        model,
      ),
    ).toBeNull();
  });

  it('reads back what it wrote, and nothing damaged', () => {
    const bytes = meaningBytes(kept);
    expect(readMeaningBytes(bytes)).toEqual(kept);
    expect(readMeaningBytes(meaningBytes(new Map()))).toEqual(new Map());
    // Every cut short, and one byte more.
    for (let length = 0; length < bytes.length; length++) {
      expect(readMeaningBytes(bytes.subarray(0, length)), `${length}`).toBeNull();
    }
    expect(readMeaningBytes(new Uint8Array([...bytes, 0]))).toBeNull();
  });

  it('reads nothing with a revision twice, a bad ID or a scale that isn’t one', () => {
    const one = [passage('Soup', 0, { 0: 1 })];
    const twice = meaningBytes(new Map([[RevisionId.parse('soup-r1'), one]]));
    // The revision's entry, written again after it, as a second revision.
    const header = 2 + 4;
    const entry = twice.subarray(header);
    const doubled = new Uint8Array([...twice.subarray(0, header), ...entry, ...entry]);
    new DataView(doubled.buffer).setUint32(2, 2);
    expect(readMeaningBytes(doubled)).toBeNull();
    const badId = twice.slice();
    badId[header + 2] = 0x20;
    expect(readMeaningBytes(badId)).toBeNull();
    const badScale = twice.slice();
    const scaleAt = header + 2 + 'soup-r1'.length + 4 + 16 + 4;
    new DataView(badScale.buffer).setFloat32(scaleAt, -1);
    expect(readMeaningBytes(badScale)).toBeNull();
    new DataView(badScale.buffer).setFloat32(scaleAt, Number.NaN);
    expect(readMeaningBytes(badScale)).toBeNull();
  });

  it('refuses to write vectors of different lengths, or a start past what it holds', () => {
    const mixed = new Map([
      [RevisionId.parse('a'), [passage('a', 0, { 0: 1 })]],
      [RevisionId.parse('b'), [{ ...passage('b', 0, { 0: 1 }), vector: quantizeVector([1, 0]) }]],
    ]);
    expect(() => meaningBytes(mixed)).toThrow();
    const far = new Map([[RevisionId.parse('a'), [{ ...passage('a', 0, { 0: 1 }), start: -1 }]]]);
    expect(() => meaningBytes(far)).toThrow();
  });
});
