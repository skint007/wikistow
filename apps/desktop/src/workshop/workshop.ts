import { pluginRoutes } from '@wikistow/contracts';
import { checkPlugin, fileType, PluginFolderError } from '@wikistow/plugin-sdk/files';
import { PluginFile } from '@wikistow/plugin-sdk/manifest';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readPluginFolder } from '../plugins/folder.ts';
import type { PluginAddress, PluginFile as ServedFile } from '../plugins/plugins.ts';

/** A workshop request refused, with a message for the person. */
export class WorkshopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkshopError';
  }
}

const Files = z
  .array(z.object({ path: z.string(), data: z.instanceof(Uint8Array) }))
  .min(1)
  .max(pluginRoutes.MAX_VERSION_FILES);

/** The URL key a previewed build is served under, `draft-<hash>` (ADR 0004). */
const KEY = /^draft-([0-9a-f]{64})$/;

/**
 * Builds the page made in its workshop (ADR 0004), checked here as the
 * library checks an upload, since app code runs in the same page: every
 * path a plain one inside the folder, no file with a folder's name, the
 * library's limits, and the manifest and the files it names
 * (`checkPlugin`). The checked files, by path, and their manifest and hash.
 */
async function checked(input: unknown) {
  const files = Files.parse(input);
  const byPath = new Map<string, Uint8Array>();
  for (const { path, data } of files) {
    if (!PluginFile.max(200).safeParse(path).success) {
      throw new WorkshopError(`“${path}” isn’t a plain path inside a plugin.`);
    }
    if (byPath.has(path)) throw new WorkshopError(`${path} is listed twice.`);
    byPath.set(path, data);
  }
  const folders = new Set(
    files.flatMap(({ path }) =>
      path
        .split('/')
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join('/')),
    ),
  );
  if (files.some(({ path }) => folders.has(path))) {
    throw new WorkshopError('A file has a folder’s name.');
  }
  const size = files.reduce((total, { data }) => total + data.length, 0);
  if (size > pluginRoutes.MAX_VERSION_BYTES) {
    throw new WorkshopError('A plugin holds 10 MB at most.');
  }
  const plugin = await checkPlugin(byPath).catch((error: unknown) => {
    throw error instanceof PluginFolderError ? new WorkshopError(error.message) : error;
  });
  const script = plugin.manifest.script && byPath.get(plugin.manifest.script);
  if (script && script.length > pluginRoutes.MAX_SCRIPT_BYTES) {
    throw new WorkshopError('A plugin’s script is 1 MB at most.');
  }
  return { ...plugin, byPath };
}

/** Write `byPath` into the new folder `folder`. */
async function writeAll(folder: string, byPath: ReadonlyMap<string, Uint8Array>) {
  for (const [path, data] of byPath) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), data);
  }
}

/**
 * The plugin workshop's part in the main process (ADR 0004): the page
 * builds and keeps a draft's versions; main serves the builds it is handed
 * for the preview, under `/plugins/<id>/draft-<hash>/`, from
 * `<data>/workshop/<hash>/`, and exports one to a folder. Previewed builds
 * last until the window navigates; the app deletes any left when it starts.
 * Whether it holds any tells main a preview ran plugin code in the window.
 */
export function desktopWorkshop(data: string) {
  const root = join(data, 'workshop');
  /** The builds served, by hash, with their plugin's ID. */
  const held = new Map<string, string>();

  return {
    /** Delete what an earlier run left. */
    async load() {
      await rm(root, { recursive: true, force: true });
    },

    /** Serve a build the page made, checked. Its hash, which the page compares with its own. */
    async preview(input: unknown) {
      const { manifest, hash, byPath } = await checked(input);
      if (held.get(hash) === manifest.id) return hash;
      // Written in full, read back and hashed again, then moved into place.
      const temporary = join(root, `staging-${randomUUID()}`);
      try {
        await writeAll(temporary, byPath);
        if ((await readPluginFolder(temporary)).hash !== hash) {
          throw new WorkshopError('The preview’s copy doesn’t match the version built.');
        }
        await rm(join(root, hash), { recursive: true, force: true });
        await rename(temporary, join(root, hash));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      held.set(hash, manifest.id);
      return hash;
    },

    /** Whether any build was previewed since the window last navigated. */
    previewing: () => held.size > 0,

    /** Stop serving previewed builds, as the page that made them goes. */
    async clear() {
      if (held.size === 0) return;
      held.clear();
      await rm(root, { recursive: true, force: true });
    },

    /**
     * Copy a build the page made, if its files hash to `hash`, the version
     * the person reviewed, into a new folder in the one `choose` asks for:
     * `<id>-<first 8 of the hash>`. The folder written, or null if cancelled.
     */
    async exportTo(input: unknown, hash: unknown, choose: () => Promise<string | null>) {
      const plugin = await checked(input);
      if (plugin.hash !== z.string().parse(hash)) {
        throw new WorkshopError('The exported files don’t match the reviewed version.');
      }
      const parent = await choose();
      if (parent === null) return null;
      const target = join(parent, `${plugin.manifest.id}-${plugin.hash.slice(0, 8)}`);
      const taken = await stat(target).then(
        () => true,
        () => false,
      );
      if (taken) throw new WorkshopError(`${target} already exists.`);
      await writeAll(target, plugin.byPath);
      // What was written is what was reviewed.
      if ((await readPluginFolder(target)).hash !== plugin.hash) {
        throw new WorkshopError('The exported files don’t match the reviewed version.');
      }
      return target;
    },

    /**
     * The file for `/plugins/<id>/draft-<hash>/<path>`: a previewed build's,
     * inside its folder. Null for anything else.
     */
    file({ id, key, path }: PluginAddress): ServedFile | null {
      const hash = KEY.exec(key)?.[1];
      if (!hash || held.get(hash) !== id) return null;
      const base = resolve(root, hash);
      const file = resolve(base, path);
      const inside = relative(base, file);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
      return { path: file, type: fileType(file) };
    },
  };
}
