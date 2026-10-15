import {
  checkPlugin,
  noManifest,
  PluginFolderError,
  type CheckedPlugin,
} from '@wikistow/plugin-sdk/files';
import { MANIFEST_FILE } from '@wikistow/plugin-sdk/manifest';
import { access, copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export { PluginFolderError };

const MAX_FILES = 500;
const MAX_BYTES = 50 * 1024 * 1024;

/** A built plugin folder, read and checked. */
export type PluginFolder = CheckedPlugin & { folder: string };

/**
 * Read a built plugin folder: its manifest, the files the manifest names,
 * and a hash of everything in it (`checkPlugin`, shared with the server's
 * library). A link anywhere in it is refused, so every file read is the
 * folder's own.
 */
export async function readPluginFolder(folder: string): Promise<PluginFolder> {
  // Checked before the folder is walked, as it could be any folder at all.
  await access(join(folder, MANIFEST_FILE)).catch(() => {
    throw noManifest();
  });
  const files = new Map<string, Uint8Array>();
  let bytes = 0;
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new PluginFolderError('A plugin folder can’t hold links.');
    if (!entry.isFile()) continue;
    const contents = await readFile(path);
    files.set(relative(folder, path).split(sep).join('/'), contents);
    bytes += contents.length;
    if (files.size > MAX_FILES || bytes > MAX_BYTES) {
      throw new PluginFolderError('This plugin folder is too large (500 files or 50 MB at most).');
    }
  }
  return { folder, ...(await checkPlugin(files)) };
}

/**
 * Copy the files `read` listed into `destination`, which must not exist:
 * an install keeps its own copy, read and hashed again there, so what is
 * approved is what runs, whatever happens to the folder it came from.
 */
export async function copyPluginFiles({ folder, files }: PluginFolder, destination: string) {
  for (const file of files) {
    const to = join(destination, file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(folder, file), to);
  }
}
