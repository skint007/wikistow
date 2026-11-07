import { readdir, readFile } from 'node:fs/promises';
import { DATA_REGIONS, REGIONS } from '@wikistow/plugin-sdk';
import { expect, it } from 'vite-plus/test';

// The SDK's README lists the regions and the `data-region` hooks as the
// SDK's tables have them (#281), and the app marks exactly the hooks the
// table lists. A failure prints the table the README should hold.

const README = new URL('../../plugin-sdk/README.md', import.meta.url);
const SOURCE = new URL('../src/', import.meta.url);

const regionTable = [
  '| Region | Registers | Where | On a phone |',
  '| --- | --- | --- | --- |',
  ...Object.entries(REGIONS).map(
    ([name, { registers, where, phone }]) =>
      `| \`${name}\` | \`${registers}\` | ${where} | ${phone} |`,
  ),
].join('\n');

const hookTable = [
  '| `data-region` | What it marks |',
  '| --- | --- |',
  ...Object.entries(DATA_REGIONS).map(([name, what]) => `| \`${name}\` | ${what} |`),
].join('\n');

it("lists every region and data-region hook in the README as the SDK's tables have them", async () => {
  const readme = await readFile(README, 'utf8');
  expect(readme).toContain(regionTable);
  expect(readme).toContain(hookTable);
});

it('marks the data-region hooks the SDK lists, and only those', async () => {
  const files = (await readdir(SOURCE, { recursive: true })).filter((file) =>
    file.endsWith('.tsx'),
  );
  const marked = new Set<string>();
  for (const file of files) {
    const text = await readFile(new URL(file, SOURCE), 'utf8');
    for (const [, name] of text.matchAll(/data-region="([^"]+)"/g)) if (name) marked.add(name);
  }
  expect([...marked].sort()).toEqual(Object.keys(DATA_REGIONS).sort());
});
