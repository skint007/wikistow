import { PluginFile } from '@wikistow/plugin-sdk/manifest';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where library plugins' files live. Postgres keeps their rows. */
export type PluginStore = {
  /**
   * Store a version's files under its hash, all at once: they are written
   * to staging and moved into place, so a crash never leaves half a
   * version under its name. Nothing changes if the hash is there already.
   */
  put(hash: string, files: ReadonlyMap<string, Uint8Array>): Promise<void>;
  /** A file's bytes, or null if the version has no such file. */
  get(hash: string, path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  delete(hash: string): Promise<void>;
  /** Stored versions with when each was written, for the orphan sweep. */
  list(): AsyncIterable<{ hash: string; writtenAt: Date }>;
  /** Remove staged versions older than `olderThanMs`, left by interrupted uploads. */
  clearStaging(olderThanMs: number): Promise<void>;
};

const HASH = /^[0-9a-f]{64}$/;
// A path with no way out of the version's folder.
const isPath = (path: string) => PluginFile.safeParse(path).success;

const isMissing = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR');

const isTaken = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOTEMPTY' || error.code === 'EEXIST');

/**
 * Versions as folders under `dir/plugins/<hash>/`, beside the attachment
 * blobs, so backups take them with the blobs. Uploads are written into
 * `dir/plugin-staging` first. Hashes and paths are checked, so nothing can
 * escape `dir`.
 */
export function filePluginStore(dir: string): PluginStore {
  const versions = join(dir, 'plugins');
  const staging = join(dir, 'plugin-staging');
  const folderFor = (hash: string) => {
    if (!HASH.test(hash)) throw new Error('invalid plugin hash');
    return join(versions, hash);
  };

  return {
    async put(hash, files) {
      const target = folderFor(hash);
      const temporary = join(staging, randomBytes(12).toString('hex'));
      try {
        for (const [path, bytes] of files) {
          if (!isPath(path)) throw new Error('invalid plugin file path');
          const to = join(temporary, path);
          await mkdir(dirname(to), { recursive: true });
          await writeFile(to, bytes);
        }
        await mkdir(versions, { recursive: true });
        await rename(temporary, target).catch((error: unknown) => {
          // The same upload landed first; its files are these.
          if (!isTaken(error)) throw error;
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    async get(hash, path) {
      if (!isPath(path)) return null;
      try {
        return await readFile(join(folderFor(hash), path));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async delete(hash) {
      await rm(folderFor(hash), { recursive: true, force: true });
    },
    async *list() {
      const names = await readdir(versions).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
      for (const name of names) {
        if (!HASH.test(name)) continue;
        yield { hash: name, writtenAt: (await stat(join(versions, name))).mtime };
      }
    },
    async clearStaging(olderThanMs) {
      const names = await readdir(staging).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
      const cutoff = Date.now() - olderThanMs;
      for (const name of names) {
        const path = join(staging, name);
        const written = await stat(path).catch(() => null);
        if (written && written.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
      }
    },
  };
}
