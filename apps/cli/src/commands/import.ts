// `wikistow import`: a Joplin export or an Obsidian vault as folders and
// published pages (wikistow.md, Import), as Import… does in WikiStow.
import {
  archiveFiles,
  importFromOf,
  importOperations,
  readImport,
  UnreadableArchive,
  type ImportFile,
  type ImportFrom,
  type ImportSource,
} from '@wikistow/client';
import type { FolderId, SpaceId } from '@wikistow/contracts';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { finish, openAgent } from '../agent.ts';
import { CliError, stateNotSaved } from '../exit.ts';
import type { Io, Printer } from '../io.ts';
import type { Deps } from './agent.ts';
import { shareStart, spaceOfFolder, type ContentArgs } from './content.ts';

/** A directory's files, every folder down, read when wanted; links are left out. */
function folderFiles(root: string): ImportFile[] {
  const files: ImportFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) {
        files.push({
          path: relative(root, path).split(sep).join('/').normalize('NFC'),
          size: stats.size,
          read: async () => readFileSync(path),
        });
      }
    }
  };
  walk(root);
  return files;
}

/**
 * PATH as a Joplin export (a Markdown export's folder, or a JEX or zip
 * file) or an Obsidian vault (its folder or a zip), `from` saying which
 * when its files don't.
 */
async function readExport(path: string, from: ImportFrom | null): Promise<ImportSource> {
  let files: ImportFile[];
  try {
    files = lstatSync(path).isDirectory() ? folderFiles(path) : archiveFiles(readFileSync(path));
  } catch (cause) {
    if (cause instanceof UnreadableArchive) {
      throw new CliError('usage', `${path}: ${cause.message}`, { cause });
    }
    throw new CliError('usage', `Can't read ${path}`, { cause });
  }
  const app = from ?? (await importFromOf(files));
  if (app === null) {
    throw new CliError(
      'usage',
      `Can't tell whether ${path} is an Obsidian vault or a Joplin export: give --from obsidian or --from joplin`,
    );
  }
  const source = await readImport(files, app);
  if (source.notes.length === 0 && source.encrypted === 0) {
    throw new CliError(
      'usage',
      `${path} has no ${app === 'obsidian' ? 'Obsidian' : 'Joplin'} notes`,
    );
  }
  return source;
}

/**
 * `import PATH [--space S] [--folder F] [--from obsidian|joplin]`: a Joplin
 * export (a JEX file, or a Markdown + Front Matter export's folder or zip)
 * or an Obsidian vault (its folder or a zip) into `--folder`, or the top of
 * this agent's share in `--space`, as `importNotes` does it. Its
 * many changes skip the journal: the import keeps its own keys, so running
 * it again finishes one cut short and changes nothing already there. SIGINT
 * or SIGTERM stops it at the next step.
 */
export async function importNotes(
  io: Io,
  out: Printer,
  args: ContentArgs & {
    path: string;
    from: ImportFrom | null;
    spaceId: SpaceId | null;
    folderId: FolderId | null;
  },
  deps: Deps,
) {
  const source = await readExport(args.path, args.from);
  const agent = await openAgent(io, {
    unlock: args.unlock,
    makeStore: deps.makeStore,
    send: deps.send,
    journaled: false,
  });
  const stop = io.stopOnSignal();
  let done: {
    spaceId: SpaceId;
    folderId: FolderId | null;
    summary: importOperations.ImportSummary;
  };
  try {
    const { ctx } = agent;
    let { spaceId, folderId } = args;
    if (spaceId === null) {
      if (folderId === null) throw new CliError('usage', 'Give --space, --folder or both');
      spaceId = await spaceOfFolder(ctx, folderId);
    } else if (folderId === null) {
      folderId = await shareStart(ctx, spaceId, '--folder');
    }
    const summary = await importOperations.importNotes(ctx, {
      scope: { spaceId, ...(folderId === null ? {} : { folderId }) },
      source,
      signal: stop.signal,
    });
    done = { spaceId, folderId, summary };
  } catch (error) {
    await finish(agent).catch(() => {});
    if (error instanceof importOperations.ImportStopped) {
      throw new CliError('cancelled', 'Stopped; run the same import again to finish it');
    }
    throw error;
  } finally {
    stop.release();
  }
  await finish(agent).catch((error: unknown) => out.warn(stateNotSaved(error)));
  const { summary } = done;
  out.result(
    { spaceId: done.spaceId, folderId: done.folderId, format: source.format, ...summary },
    () => {
      const n = (count: number, what: string) => `${count} ${what}${count === 1 ? '' : 's'}`;
      out.line(
        `Imported ${n(summary.pages.length, 'page')}, ${n(summary.folders, 'folder')} and ${n(summary.attachments, 'attachment')}`,
      );
      if (summary.existing > 0) {
        out.line(`  ${n(summary.existing, 'page')} already imported, left as they were`);
      }
      for (const { path, link } of summary.unresolved) {
        out.note(`Left a link as written in ${out.foreign(path)}: ${out.foreign(link)}`);
      }
      for (const { path, reason } of summary.skipped) {
        const why =
          reason === 'encrypted'
            ? 'it is encrypted; decrypt it in Joplin first'
            : reason === 'unused'
              ? 'no imported note links to it'
              : 'it is too large';
        out.note(`Left out ${out.foreign(path)}: ${why}`);
      }
      if (summary.encrypted > 0) {
        out.note(`${n(summary.encrypted, 'item')} in the export are still encrypted`);
      }
    },
  );
}
