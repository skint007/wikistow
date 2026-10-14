import { Manifest, MANIFEST_FILE, manifestFiles } from '@wikistow/plugin-sdk/manifest';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** A plugin folder can't be read as one; the message says why, for the person. */
export class PluginFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginFolderError';
  }
}

const MAX_FILES = 500;
const MAX_BYTES = 50 * 1024 * 1024;

/** A built plugin folder, read and checked. */
export type PluginFolder = {
  folder: string;
  manifest: Manifest;
  /** Every file in it, by its path from the top with `/` between names. */
  files: string[];
  /** SHA-256 over every file's path and contents, which approval binds to. */
  hash: string;
};

/**
 * Read a built plugin folder: its manifest, the files the manifest names,
 * and a hash of everything in it. A link anywhere in it is refused, so
 * every file read is the folder's own.
 */
export async function readPluginFolder(folder: string): Promise<PluginFolder> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(folder, MANIFEST_FILE), 'utf8'));
  } catch {
    throw new PluginFolderError(
      `This folder has no readable ${MANIFEST_FILE}. Choose a built plugin’s folder (its dist).`,
    );
  }
  const checked = Manifest.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new PluginFolderError(
      `${MANIFEST_FILE} isn’t valid: ${issue?.path.join('.') || 'it'}: ${issue?.message ?? 'unknown'}`,
    );
  }
  const manifest = checked.data;
  const files: string[] = [];
  let bytes = 0;
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new PluginFolderError('A plugin folder can’t hold links.');
    if (!entry.isFile()) continue;
    files.push(relative(folder, path).split(sep).join('/'));
    bytes += (await lstat(path)).size;
    if (files.length > MAX_FILES || bytes > MAX_BYTES) {
      throw new PluginFolderError('This plugin folder is too large (500 files or 50 MB at most).');
    }
  }
  files.sort();
  const missing = manifestFiles(manifest).filter((file) => !files.includes(file));
  if (missing.length > 0) {
    throw new PluginFolderError(
      `${MANIFEST_FILE} names files the folder lacks: ${missing.join(', ')}`,
    );
  }
  const hash = createHash('sha256');
  for (const file of files) {
    const contents = await readFile(join(folder, file));
    hash.update(`${file}\0${contents.length}\0`).update(contents);
  }
  return { folder, manifest, files, hash: hash.digest('hex') };
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
