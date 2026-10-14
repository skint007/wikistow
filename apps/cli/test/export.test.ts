import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { OutDir } from '../src/commands/export.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const scratch = () => mkdtemp(join(tmpdir(), 'wikistow-export-'));

describe('the directory an export writes into', () => {
  it('is refused when it holds anything', async () => {
    const full = await scratch();
    await writeFile(join(full, '.hidden'), '');
    expect(() => new OutDir(full)).toThrow(code('usage'));
  });

  it('never writes over a file', async () => {
    const out = join(await scratch(), 'out');
    const dir = new OutDir(out);
    dir.write('once.md', new Uint8Array([1]));
    expect(() => dir.write('once.md', new Uint8Array([2]))).toThrow();
    expect(readFileSync(join(out, 'once.md'))).toEqual(Buffer.from([1]));
  });
});
