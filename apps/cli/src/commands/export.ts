// `wikistow export`: what this agent can read, as Markdown files on disk.
import { exportOperations, type FolderId, type SpaceId } from '@wikistow/client';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { CliError } from '../exit.ts';
import { WINDOWS } from '../files.ts';
import type { Io, Printer } from '../io.ts';
import type { Deps } from './agent.ts';
import { spaceOfFolder, withAgent, type ContentArgs } from './content.ts';

/**
 * `export [--space S] [--folder F] --out DIR`: every page this agent can
 * read, each as `page read` would show it (the draft if it edits the page),
 * as one `.md` file in folders that mirror the tree, with attachments in
 * `attachments/` and wikilinks naming the files written. `--space` exports
 * one space, `--folder` one folder; without either, each space goes in a
 * folder of its own. DIR must be empty or not exist yet. Folders are made
 * mode 700 and files 600, never over anything there, and if the export
 * fails, what it wrote is removed. A page or attachment that doesn't open
 * is left out and listed, and the export goes on.
 */
export async function exportMarkdown(
  io: Io,
  out: Printer,
  args: ContentArgs & { spaceId: SpaceId | null; folderId: FolderId | null; out: string },
  deps: Deps,
) {
  const dir = new OutDir(args.out);
  let summary: exportOperations.ExportSummary;
  try {
    summary = await withAgent(io, out, args, deps, async ({ ctx }) => {
      const spaceId =
        args.spaceId ?? (args.folderId === null ? null : await spaceOfFolder(ctx, args.folderId));
      const scope =
        spaceId === null
          ? undefined
          : { spaceId, ...(args.folderId === null ? {} : { folderId: args.folderId }) };
      return exportOperations.exportMarkdown(ctx, {
        ...(scope ? { scope } : {}),
        write: (entry) =>
          entry.kind === 'dir' ? dir.mkdir(entry.path) : dir.write(entry.path, entry.bytes),
      });
    });
  } catch (error) {
    dir.undo();
    throw error;
  }
  const { pages, attachments, skipped, unread } = summary;
  out.result({ out: args.out, pages, attachments, skipped, unread }, () => {
    const files = `${pages.length} page${pages.length === 1 ? '' : 's'} and ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`;
    out.line(`Exported ${files} to ${args.out}`);
    for (const item of skipped) {
      if (!('attachmentId' in item)) {
        out.note(`Left out page ${item.pageId}: it couldn't be opened`);
        continue;
      }
      const why =
        item.reason === 'missing' ? 'the server has no file for it' : "it couldn't be opened";
      out.note(`Left out attachment ${out.foreign(item.path)}: ${why}`);
    }
    for (const item of unread) {
      out.note(`Wrote ${out.foreign(item.path)} as it was: its links couldn't be read`);
    }
  });
}

/**
 * The directory an export writes into: refused unless it is empty or
 * missing (then made, mode 700), a real directory of this user's that
 * nobody else can get into, so nothing can be swapped in or listed while
 * it is written. Everything goes beneath it, by paths checked to stay there.
 *
 * It is where the path leads with `.` and `..` read as written, links among
 * the folders above it followed once (macOS's `/tmp` is one). It is refused
 * if it is a link itself, or the system reads the path otherwise, as it does
 * `link/.` or `link/..`: what the path names must be the directory written.
 */
export class OutDir {
  readonly #root: string;
  /** What this run made, in order, so a failed run can remove it. */
  readonly #made: { path: string; dir: boolean }[] = [];

  constructor(given: string) {
    const full = resolve(given);
    // `link/` would have the system follow the link. Windows takes `\` as a separator too.
    const written = given.replace(WINDOWS ? /(?<=.)[\\/]+$/ : /(?<=.)\/+$/, '');
    const name = written.slice(
      Math.max(written.lastIndexOf('/'), WINDOWS ? written.lastIndexOf('\\') : -1) + 1,
    );
    // The system's own reading: Node's `realpathSync` takes `..` as written first.
    const real = realpathSync.native;
    let path: string;
    try {
      path = join(real(dirname(full)), basename(full));
      // How the system reads it: through its own parent, unless it ends in `.` or `..`.
      const found =
        name === '.' || name === '..'
          ? real(written)
          : join(real(written.slice(0, written.length - name.length) || '.'), name);
      // Windows names are case-blind, and PowerShell keeps a folder's case as typed.
      const same = WINDOWS ? found.toLowerCase() === path.toLowerCase() : found === path;
      if (!same) {
        throw new CliError(
          'usage',
          `${given} goes through a link to ${found}: give --out the directory's own path`,
        );
      }
    } catch (cause) {
      if (cause instanceof CliError) throw cause;
      throw new CliError('usage', `Can't make ${given}`, { cause });
    }
    let stats = lstatOrNull(path);
    if (!stats) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (cause) {
        throw new CliError('usage', `Can't make ${path}`, { cause });
      }
      this.#made.push({ path, dir: true });
      stats = lstatSync(path);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new CliError('usage', `${path} is not a directory`);
    }
    // Windows has no owners or modes to check (`files.ts`).
    if (!WINDOWS) {
      // Whose it is first: another user's may not even be readable.
      if (stats.uid !== (process.getuid?.() ?? -1)) {
        throw new CliError('usage', `${path} belongs to another user: give --out one of your own`);
      }
      if ((stats.mode & 0o077) !== 0) {
        const mode = (stats.mode & 0o777).toString(8);
        throw new CliError(
          'usage',
          `${path} has mode ${mode}, which lets others in; run chmod 700 on it`,
        );
      }
    }
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch (cause) {
      throw new CliError('usage', `Can't read ${path}`, { cause });
    }
    if (entries.length > 0) {
      throw new CliError('usage', `${path} is not empty: give --out a new or empty directory`);
    }
    this.#root = path;
  }

  /** `path` beneath the directory, or a refusal: no part may climb out or be empty. */
  #inside(path: string): string {
    const parts = path.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\0'))) {
      throw new CliError('failed', 'The export named a path outside its directory');
    }
    const full = resolve(this.#root, ...parts);
    if (!full.startsWith(this.#root + sep)) {
      throw new CliError('failed', 'The export named a path outside its directory');
    }
    return full;
  }

  mkdir(path: string): void {
    const full = this.#inside(path);
    // Never one that is there already, so never a link someone put there.
    mkdirSync(full, { mode: 0o700 });
    this.#made.push({ path: full, dir: true });
  }

  write(path: string, bytes: Uint8Array): void {
    const full = this.#inside(path);
    const fd = openSync(
      full,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    this.#made.push({ path: full, dir: false });
    try {
      for (let written = 0; written < bytes.length;) {
        written += writeSync(fd, bytes, written);
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Remove what this run made, newest first. */
  undo(): void {
    for (const { path, dir } of this.#made.reverse()) {
      try {
        if (dir) rmdirSync(path);
        else rmSync(path, { force: true });
      } catch {
        // Something else is in it now: leave it.
      }
    }
    this.#made.length = 0;
  }
}

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};
