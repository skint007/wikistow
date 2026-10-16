import type { BuildDiagnostic, WorkshopFile, WorkshopVersion } from '@wikistow/contracts';
import { fileType } from '@wikistow/plugin-sdk/files';
import { Manifest, MANIFEST_FILE, trustLevel } from '@wikistow/plugin-sdk/manifest';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  copyPluginFiles,
  PluginFolderError,
  readPluginFolder,
  uploadFiles,
} from '../plugins/folder.ts';
import type { PluginAddress, PluginFile } from '../plugins/plugins.ts';
import type { BuildOutput, BuildRequest } from './builder.ts';

/** A workshop request refused, with a message for the person or the assistant. */
export class WorkshopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkshopError';
  }
}

/** The kinds of file a workspace holds: source, styles, data and notes, all text. */
const KINDS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.svg', '.md', '.txt']);
/** Folders and names, each starting with a letter, digit or `_`: no `..`, no hidden files. */
const PATH = /^([A-Za-z0-9_][A-Za-z0-9._-]{0,63}\/){0,5}[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const MAX_FILE = 256 * 1024;
const MAX_FILES = 200;
const MAX_TOTAL = 4 * 1024 * 1024;

const SessionId = z.uuid();
const VersionNumber = z.number().int().positive();

/** The URL key a version is served under, `workshop-<session>-<version>`. */
const KEY = /^workshop-([0-9a-f-]{36})-(\d+)$/;

type Session = {
  folder: string;
  versions: WorkshopVersion[];
  /** Builds started, which number them: failed ones too. */
  builds: number;
  /** Counts cancels: a build started before the last one makes no version. */
  run: number;
};

/** What a workshop needs from the bundler (`workshopBuilder`). */
export type Bundler = { build(request: BuildRequest): Promise<BuildOutput> };

/**
 * Plugin workshops (#257): each a staged workspace under `<data>/workshop`,
 * with its source as the assistant wrote it and every version it built, in
 * `versions/<n>/`. Only the app's main process uses it, and everything it
 * is given is checked again here: a file's path must be a plain one inside
 * the workspace, of a text kind. A workshop lasts until it ends, or the
 * window that holds its conversation reloads or goes; the app deletes any
 * left behind when it starts.
 */
export function desktopWorkshop(data: string, bundler: Bundler) {
  const root = join(data, 'workshop');
  const sessions = new Map<string, Session>();

  const sessionOf = (id: unknown) => {
    const session = sessions.get(SessionId.parse(id));
    if (!session) throw new WorkshopError('That workshop has ended.');
    return session;
  };
  const workspace = (session: Session) => join(session.folder, 'workspace');
  const versionFolder = (session: Session, version: number) =>
    join(session.folder, 'versions', String(version));

  /** `path` checked: a plain path inside the workspace, of a kind it holds. */
  const fileIn = (session: Session, path: unknown) => {
    const name = z.string().parse(path);
    if (!PATH.test(name) || !KINDS.has(extname(name).toLowerCase())) {
      throw new WorkshopError(
        `“${name}” isn’t a workspace file. Use a relative path such as src/ui.tsx, with no “..”, ending in ${[...KINDS].join(', ')}.`,
      );
    }
    return join(workspace(session), name);
  };

  /** Every file in the workspace, by path, sorted. */
  async function list(session: Session): Promise<WorkshopFile[]> {
    const top = workspace(session);
    const entries = await readdir(top, { recursive: true, withFileTypes: true });
    const files: WorkshopFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = join(entry.parentPath, entry.name);
      files.push({
        path: relative(top, full).split(sep).join('/'),
        size: (await stat(full)).size,
      });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  const failed = (version: number, diagnostics: BuildDiagnostic[]): WorkshopVersion => ({
    version,
    diagnostics,
    plugin: null,
    hash: null,
  });

  const error = (message: string, file: string | null = null): BuildDiagnostic => ({
    severity: 'error',
    file,
    line: null,
    column: null,
    message,
  });

  /**
   * Build the workspace as it is into `versions/<n>`: the manifest, `ui.js`
   * and `script.js` from `src/<name>.ts(x)`, `public/`'s files at the top,
   * as `wikistow-plugin build` lays them out, and the source it came from
   * in `source/`, so the folder says what it is. Hashed as an install would.
   */
  async function build(session: Session, version: number): Promise<WorkshopVersion> {
    const top = workspace(session);
    const files = await list(session);
    const texts = new Map<string, string>();
    for (const { path } of files) texts.set(path, await readFile(join(top, path), 'utf8'));
    const raw = texts.get(MANIFEST_FILE);
    if (raw === undefined)
      return failed(version, [error(`The workspace has no ${MANIFEST_FILE}.`)]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (problem) {
      const said = problem instanceof Error ? problem.message : 'it isn’t JSON';
      return failed(version, [error(`${MANIFEST_FILE} isn’t valid JSON: ${said}`, MANIFEST_FILE)]);
    }
    const checked = Manifest.safeParse(parsed);
    if (!checked.success) {
      return failed(
        version,
        checked.error.issues.map((issue) =>
          error(`${issue.path.join('.') || 'The manifest'}: ${issue.message}`, MANIFEST_FILE),
        ),
      );
    }
    const manifest = checked.data;
    const entries: BuildRequest['entries'] = [];
    for (const output of [manifest.ui, manifest.script]) {
      if (output === undefined) continue;
      const name = basename(output, extname(output));
      const entry = [`src/${name}.tsx`, `src/${name}.ts`].find((path) => texts.has(path));
      if (!entry)
        return failed(version, [error(`There’s no src/${name}.ts or .tsx for ${output}.`)]);
      entries.push({ output, entry });
    }
    const built = await bundler.build({ files: [...texts], entries });
    if (built.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return failed(version, built.diagnostics);
    }
    const out = versionFolder(session, version);
    const write = async (path: string, text: string) => {
      await mkdir(dirname(join(out, path)), { recursive: true });
      await writeFile(join(out, path), text);
    };
    for (const [path, text] of texts) {
      await write(`source/${path}`, text);
      if (path.startsWith('public/')) await write(path.slice('public/'.length), text);
    }
    for (const [output, text] of Object.entries(built.outputs)) await write(output, text);
    await write(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
    try {
      const read = await readPluginFolder(out);
      return {
        version,
        diagnostics: built.diagnostics,
        plugin: {
          manifest: read.manifest,
          level: trustLevel(read.manifest),
          key: `workshop-${basename(session.folder)}-${version}`,
          development: null,
          library: false,
          enabled: true,
        },
        hash: read.hash,
      };
    } catch (problem) {
      if (!(problem instanceof PluginFolderError)) throw problem;
      await rm(out, { recursive: true, force: true });
      return failed(version, [...built.diagnostics, error(problem.message)]);
    }
  }

  /** Version `version`'s built folder, if its files still hash to `hash`. */
  async function reviewed(session: Session, version: unknown, hash: unknown) {
    const number = VersionNumber.parse(version);
    const record = session.versions.find((built) => built.version === number);
    if (!record?.hash) throw new WorkshopError(`Version ${number} didn’t build.`);
    const read = await readPluginFolder(versionFolder(session, number));
    if (read.hash !== z.string().parse(hash) || read.hash !== record.hash) {
      throw new WorkshopError(`Version ${number}’s files changed since they were reviewed.`);
    }
    return read;
  }

  return {
    /** Delete what an earlier run left: workshops end with the app. */
    async load() {
      await rm(root, { recursive: true, force: true });
    },

    async start(): Promise<string> {
      const id = randomUUID();
      const session: Session = { folder: join(root, id), versions: [], builds: 0, run: 0 };
      await mkdir(workspace(session), { recursive: true });
      sessions.set(id, session);
      return id;
    },

    async end(id: unknown) {
      const parsed = SessionId.parse(id);
      const session = sessions.get(parsed);
      if (!session) return;
      sessions.delete(parsed);
      await rm(session.folder, { recursive: true, force: true });
    },

    /** End every workshop, as the window that held them reloads or goes. */
    async endAll() {
      const ending = [...sessions.values()];
      sessions.clear();
      for (const session of ending) await rm(session.folder, { recursive: true, force: true });
    },

    /** Whether any workshop is open, so the bundler can stop with the last. */
    open: () => sessions.size > 0,

    files: (id: unknown) => list(sessionOf(id)),

    async read(id: unknown, path: unknown) {
      const file = fileIn(sessionOf(id), path);
      try {
        return await readFile(file, 'utf8');
      } catch {
        throw new WorkshopError(`There’s no ${String(path)} in the workspace.`);
      }
    },

    async write(id: unknown, path: unknown, text: unknown) {
      const session = sessionOf(id);
      const file = fileIn(session, path);
      const contents = z.string().parse(text);
      const bytes = Buffer.byteLength(contents);
      if (bytes > MAX_FILE) throw new WorkshopError('A workspace file holds 256 KB at most.');
      const others = (await list(session)).filter(
        (entry) => join(workspace(session), entry.path) !== file,
      );
      if (others.length + 1 > MAX_FILES) {
        throw new WorkshopError(`A workspace holds ${MAX_FILES} files at most.`);
      }
      if (others.reduce((total, entry) => total + entry.size, bytes) > MAX_TOTAL) {
        throw new WorkshopError('A workspace holds 4 MB at most.');
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    },

    async remove(id: unknown, path: unknown) {
      await rm(fileIn(sessionOf(id), path), { force: true });
    },

    /** Build the next version. Null if the workshop ended, or was cancelled, meanwhile. */
    async build(id: unknown): Promise<WorkshopVersion | null> {
      const session = sessionOf(id);
      const { run } = session;
      const version = ++session.builds;
      const built = await build(session, version).catch((problem: unknown) =>
        failed(version, [error(problem instanceof Error ? problem.message : 'The build failed.')]),
      );
      if (sessions.get(SessionId.parse(id)) !== session || session.run !== run) {
        await rm(versionFolder(session, version), { recursive: true, force: true });
        // Its number goes to the next build, unless another started meanwhile.
        if (session.builds === version) session.builds -= 1;
        return null;
      }
      session.versions.push(built);
      return built;
    },

    cancel(id: unknown) {
      const session = sessions.get(SessionId.parse(id));
      if (session) session.run += 1;
    },

    /** Copy a reviewed version into a new folder in `parent`. The folder written. */
    async exportTo(id: unknown, version: unknown, hash: unknown, parent: string) {
      const read = await reviewed(sessionOf(id), version, hash);
      // Named by the ID and number only: the manifest's version is free text.
      const target = join(parent, `${read.manifest.id}-v${String(version)}`);
      const taken = await stat(target).then(
        () => true,
        () => false,
      );
      if (taken) throw new WorkshopError(`${target} already exists.`);
      await copyPluginFiles(read, target);
      // What was written is what was reviewed.
      if ((await readPluginFolder(target)).hash !== read.hash) {
        throw new WorkshopError('The exported files don’t match the reviewed version.');
      }
      return target;
    },

    /** A reviewed version's folder, for the usual install with its approval. */
    async installFolder(id: unknown, version: unknown, hash: unknown) {
      return (await reviewed(sessionOf(id), version, hash)).folder;
    },

    /** A reviewed version's files, to share to the library. */
    async uploadFiles(id: unknown, version: unknown, hash: unknown) {
      return uploadFiles(await reviewed(sessionOf(id), version, hash));
    },

    /**
     * The file for `/plugins/<id>/workshop-<session>-<version>/<path>`: a
     * built version's, inside its folder. Null for anything else.
     */
    file({ id, key, path }: PluginAddress): PluginFile | null {
      const match = KEY.exec(key);
      const session = match?.[1] ? sessions.get(match[1]) : undefined;
      const record = session?.versions.find((built) => built.version === Number(match?.[2]));
      if (!session || !record?.plugin || record.plugin.manifest.id !== id) return null;
      const base = resolve(versionFolder(session, record.version));
      const file = resolve(base, path);
      const inside = relative(base, file);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
      return { path: file, type: fileType(file) };
    },
  };
}
