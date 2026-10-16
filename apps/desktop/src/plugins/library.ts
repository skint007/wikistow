import {
  pluginRoutes,
  type InstalledPlugin,
  type LibraryApproval,
  type LibraryCopies,
} from '@wikistow/contracts';
import { checkPlugin, fileType } from '@wikistow/plugin-sdk/files';
import { PluginId, trustLevel, type Manifest } from '@wikistow/plugin-sdk/manifest';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { PluginFolderError, readPluginFolder } from './folder.ts';
import type { PluginAddress, PluginFile } from './plugins.ts';

const Approved = z
  .array(z.strictObject({ id: PluginId, hash: pluginRoutes.PluginHash, enabled: z.boolean() }))
  .max(500);

/** A GET of `path` on the server, with the app's session. */
export type Upstream = (path: string) => Promise<Response>;

/** A problem said beside the plugin in Settings, in place of the error behind it. */
class NotInstalled extends Error {}

const NOT_LISTED =
  'It isn’t on this computer, and the version you approved is no longer in the library.';
const MISMATCH =
  'Its files on the server don’t match the version you approved, so it wasn’t installed.';

/**
 * The library plugins the account approved, as copies on this computer
 * (ADR 0002), in `<data>/library-plugins/<id>/<hash>/`. The pages say
 * which are approved, since the approvals are encrypted; a copy is
 * downloaded through the app's session, from the library's own file route,
 * and kept only if every file hashes to the approved hash, so the server
 * can't send this computer code nobody approved. Only the main process uses it.
 */
export function libraryPlugins(data: string, upstream: Upstream) {
  const root = join(data, 'library-plugins');
  const staging = join(data, 'library-plugins.staging');
  /** Copies read and checked since launch, by `<id>/<hash>`. */
  const checked = new Map<string, Manifest>();
  /** What the last sync holds and serves. */
  let held: InstalledPlugin[] = [];
  let running: Promise<unknown> = Promise.resolve();

  const get = async (path: string) => {
    const response = await upstream(path);
    if (response.ok) return response;
    await response.body?.cancel();
    throw new NotInstalled('It couldn’t be downloaded from the server.');
  };

  /** Download version `hash` of `id`, check it, and move it into place. */
  async function download(id: string, hash: string, listing: () => Promise<LibraryPlugin[]>) {
    const version = (await listing())
      .find((plugin) => plugin.id === id)
      ?.versions.find((each) => each.hash === hash);
    if (!version) throw new NotInstalled(NOT_LISTED);
    // No version the library keeps is larger, so a larger one isn't it.
    if (version.files.length > pluginRoutes.MAX_VERSION_FILES) throw new NotInstalled(MISMATCH);
    const files = new Map<string, Uint8Array>();
    let bytes = 0;
    for (const path of version.files) {
      const response = await get(pluginRoutes.fileUrl(id, hash, path));
      const contents = new Uint8Array(await response.arrayBuffer());
      bytes += contents.length;
      if (bytes > pluginRoutes.MAX_VERSION_BYTES) throw new NotInstalled(MISMATCH);
      files.set(path, contents);
    }
    const read = await checkPlugin(files).catch(() => null);
    if (read?.hash !== hash || read.manifest.id !== id) throw new NotInstalled(MISMATCH);
    // Written in full, read back and hashed again, then moved into place.
    const temporary = join(staging, randomUUID());
    try {
      for (const [path, contents] of files) {
        await mkdir(dirname(join(temporary, path)), { recursive: true });
        await writeFile(join(temporary, path), contents);
      }
      if ((await readPluginFolder(temporary)).hash !== hash) throw new NotInstalled(MISMATCH);
      const target = join(root, id, hash);
      await rm(target, { recursive: true, force: true });
      await mkdir(join(root, id), { recursive: true });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return read.manifest;
  }

  /** The copy of `hash` of `id`, checked once a launch; downloaded if it is missing or damaged. */
  async function copy(id: string, hash: string, listing: () => Promise<LibraryPlugin[]>) {
    const name = `${id}/${hash}`;
    const known = checked.get(name);
    if (known) return known;
    const read = await readPluginFolder(join(root, id, hash)).catch(() => null);
    const manifest =
      read?.hash === hash && read.manifest.id === id
        ? read.manifest
        : await download(id, hash, listing);
    checked.set(name, manifest);
    return manifest;
  }

  /** Delete the copies `approved` doesn't name, and anything left half-done. */
  async function prune(approved: LibraryApproval[]) {
    await rm(staging, { recursive: true, force: true });
    const keep = new Set(approved.map(({ id, hash }) => `${id}/${hash}`));
    for (const id of await readdir(root).catch(() => [])) {
      const hashes = await readdir(join(root, id)).catch(() => []);
      for (const hash of hashes) {
        if (keep.has(`${id}/${hash}`)) continue;
        checked.delete(`${id}/${hash}`);
        await rm(join(root, id, hash), { recursive: true, force: true });
      }
      if (hashes.every((hash) => !keep.has(`${id}/${hash}`)))
        await rm(join(root, id), { recursive: true, force: true });
    }
  }

  async function sync(input: unknown): Promise<LibraryCopies> {
    const approved = Approved.parse(input);
    await prune(approved);
    // Listed once, only if something needs downloading.
    let listed: Promise<LibraryPlugin[]> | null = null;
    const listing = () =>
      (listed ??= get('/api/plugins').then(
        async (response) => pluginRoutes.listPlugins.response.parse(await response.json()).plugins,
      ));
    const plugins: InstalledPlugin[] = [];
    const problems: Record<string, string> = {};
    for (const { id, hash, enabled } of approved) {
      try {
        const manifest = await copy(id, hash, listing);
        plugins.push({
          manifest,
          level: trustLevel(manifest),
          key: hash,
          development: null,
          library: true,
          enabled,
        });
      } catch (error) {
        problems[id] =
          error instanceof NotInstalled || error instanceof PluginFolderError
            ? error.message
            : 'It couldn’t be downloaded from the server.';
      }
    }
    held = plugins;
    return { plugins, problems };
  }

  return {
    /** Match the copies here to `approved` (`LibraryApproval[]`), one sync at a time. */
    sync(approved: unknown): Promise<LibraryCopies> {
      const next = running.then(() => sync(approved));
      running = next.catch(() => {});
      return next;
    },

    /** The file at `address`: an enabled copy's, at its hash, inside its folder. Null for anything else. */
    file({ id, key, path }: PluginAddress): PluginFile | null {
      const plugin = held.find((each) => each.manifest.id === id && each.key === key);
      if (!plugin?.enabled) return null;
      const base = resolve(root, id, key);
      const file = resolve(base, path);
      const inside = relative(base, file);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
      return { path: file, type: fileType(file) };
    },
  };
}

type LibraryPlugin = pluginRoutes.LibraryPlugin;
