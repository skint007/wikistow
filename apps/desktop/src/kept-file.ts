import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A file the pages keep between launches (#3), such as the search index.
 * They seal it with a key only their unlocked vault has (`sealOnDevice`), so
 * this side only ever holds bytes it can't read. Writes and removals run one
 * at a time, in order.
 */
export function keptFile(path: string) {
  const next = `${path}.next`;
  let queue: Promise<void> = Promise.resolve();
  const run = (step: () => Promise<void>) => {
    const done = queue.then(step);
    queue = done.catch(() => {});
    return done;
  };
  return {
    /** What was kept, or null if nothing (or nothing readable) was. */
    read: () => queue.then(() => readFile(path).catch(() => null)),
    // Written whole, then moved into place, so a crash never leaves half a file.
    write: (sealed: Uint8Array) =>
      run(async () => {
        await writeFile(next, sealed, { mode: 0o600 });
        await rename(next, path);
      }),
    remove: () =>
      run(async () => {
        await rm(path, { force: true });
        await rm(next, { force: true });
      }),
  };
}

/**
 * A folder of items the pages keep for offline use (ADR 0009), each sealed
 * as `keptFile` is and named as the pages name it. The names are checked by
 * the caller (`KEPT_ITEM_NAME`), so none leaves the folder. Each item is
 * written whole to `<name>.next`, then moved into place, mode 600. Changes
 * run one at a time, in order.
 */
export function keptFolder(path: string) {
  let queue: Promise<void> = Promise.resolve();
  const run = (step: () => Promise<void>) => {
    const done = queue.then(step);
    queue = done.catch(() => {});
    return done;
  };
  const item = (name: string) => join(path, name);
  return {
    read: (name: string) => queue.then(() => readFile(item(name)).catch(() => null)),
    write: (name: string, sealed: Uint8Array) =>
      run(async () => {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await writeFile(`${item(name)}.next`, sealed, { mode: 0o600 });
        await rename(`${item(name)}.next`, item(name));
      }),
    remove: (names: readonly string[]) =>
      run(async () => {
        for (const name of names) await rm(item(name), { force: true });
      }),
    /** Each item, with its size; none for a folder not made yet. */
    list: () =>
      queue.then(async () => {
        const names = await readdir(path).catch(() => []);
        const items = await Promise.all(
          names
            .filter((name) => !name.endsWith('.next'))
            .map(async (name) => {
              const found = await stat(item(name)).catch(() => null);
              return found?.isFile() ? { name, size: found.size } : null;
            }),
        );
        return items.filter((found) => found !== null);
      }),
    /** The whole folder, unfinished writes too. */
    clear: () => run(() => rm(path, { recursive: true, force: true })),
  };
}
