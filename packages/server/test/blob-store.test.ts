import { mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import { fileBlobStore } from '../src/blobs/store.ts';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'wikistow-store-'));
  dirs.push(dir);
  return { dir, blobs: fileBlobStore(dir) };
}

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

describe('the file blob store', () => {
  it('rejects, rather than crashing, when an upload breaks off part way, and keeps nothing', async () => {
    const { dir, blobs } = await store();
    const broken = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new Uint8Array(10));
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.error(new Error('connection reset'));
      },
    });
    await expect(blobs.stage(broken, 1000)).rejects.toThrow('connection reset');
    expect(await readdir(join(dir, 'staging'))).toEqual([]);
  });

  it.runIf(process.platform === 'linux')(
    'closes the file when a download is abandoned part way',
    async () => {
      const { dir, blobs } = await store();
      // Larger than one read, so the file is still open after the first chunk.
      const staged = await blobs.stage(streamOf(new Uint8Array(1024 * 1024)), 1024 * 1024);
      await staged.commit();
      const stored = await blobs.get(staged.hash);
      const reader = stored?.body.getReader();
      await reader?.read();
      expect(await openFilesUnder(dir)).toBe(1);
      await reader?.cancel();
      await expect.poll(() => openFilesUnder(dir), { timeout: 2000 }).toBe(0);
    },
  );
});

/** How many of this process's open files are inside `dir`. */
async function openFilesUnder(dir: string) {
  const links = await Promise.all(
    (await readdir('/proc/self/fd')).map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => '')),
  );
  return links.filter((link) => link.startsWith(dir)).length;
}
