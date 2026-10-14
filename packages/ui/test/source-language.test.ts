import { expect, it } from 'vite-plus/test';
import { cpuTime } from '../../client/test/support/timing.ts';
import { INLINE_LIMIT, sourceLanguage } from '../src/page/editor/source/language.ts';

const nodes = (markdown: string) => {
  const names: string[] = [];
  sourceLanguage.language.parser
    .parse(markdown)
    .iterate({ enter: (node) => void names.push(node.name) });
  return names;
};

it('shows emphasis, but not in a paragraph too long to match it quickly (#87)', () => {
  expect(nodes('Some *emphasis*, __strong__ and ~~struck~~ text.')).toEqual(
    expect.arrayContaining(['Emphasis', 'StrongEmphasis', 'Strikethrough']),
  );
  const long = `${'*a'.repeat(32_768)} [[Plan]]`;
  expect(long.length).toBeGreaterThan(INLINE_LIMIT);
  const read = cpuTime(() => nodes(long));
  expect(read.ms).toBeLessThan(100);
  expect(read.value).not.toContain('Emphasis');
  const struck = cpuTime(() => nodes(`${'a~~ '.repeat(16_384)} [[Plan]]`));
  expect(struck.ms).toBeLessThan(100);
  expect(struck.value).not.toContain('Strikethrough');
  // A short paragraph after it still shows its own.
  expect(nodes(`${long}\n\n*short*`)).toContain('Emphasis');
});
