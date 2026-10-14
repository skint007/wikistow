import { readdir, utimes, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { readPrivateFile, withFileLock, writePrivateFile } from '../src/files.ts';
import { privateDir } from './support/fake-io.ts';

describe('a private file', () => {
  it('is written whole, mode 600, leaving nothing else behind', async () => {
    const { dir } = await privateDir();
    const path = join(dir, 'agent.key');
    writePrivateFile(path, new TextEncoder().encode('first'));
    writePrivateFile(path, new TextEncoder().encode('second'));
    expect(new TextDecoder().decode(readPrivateFile(path) ?? undefined)).toBe('second');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['agent.key']);
  });
});

describe('a lock file', () => {
  it('is taken over once its run must have died', async () => {
    const { dir } = await privateDir();
    const lock = join(dir, 'state.lock');
    await writeFile(lock, '', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(withFileLock(lock, () => 'ran')).toBe('ran');
  });
});
