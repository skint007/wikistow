import { readFile, rename, rm, writeFile } from 'node:fs/promises';

/**
 * The search index kept between launches (#3). The pages seal it with a key
 * only their unlocked vault has (`sealKept`), so this side only ever holds
 * bytes it can't read. Writes and removals run one at a time, in order.
 */
export function searchIndexFile(path: string) {
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
