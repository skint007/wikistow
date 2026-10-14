import type { FolderId, PageId, SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import {
  planningExport,
  type ExportFile,
  type ExportFolder,
  type ExportPage,
  type ExportSpace,
} from '../export.ts';
import { linkablePages } from '../links.ts';
import { linkSpans, type LinkSpans } from '../markdown/index.ts';
import { pace } from '../pace.ts';
import { readAttachment, shownVersions, type OpenedRevision } from './pages.ts';
import type { LoadedMetadata } from './records.ts';
import type { ClientContext } from './session.ts';
import { readableSpaces, unreachable } from './search.ts';
import { loadStructure } from './spaces.ts';

/** What to export: one space, or one folder of it and everything inside. */
export type ExportScope = { spaceId: SpaceId; folderId?: FolderId };

/** Pages opened, then their Markdown written, then attachments downloaded. */
export type ExportProgress = {
  phase: 'pages' | 'preparing' | 'attachments';
  done: number;
  total: number;
};

/**
 * How much an export holds: its folders and files, the bytes of its files,
 * and the UTF-8 bytes of their paths, all of them and the longest.
 */
export type ExportSize = { entries: number; bytes: number; pathBytes: number; longestPath: number };

/** Something to write: a folder, then the files in it. Paths are `/`-separated and relative. */
export type ExportEntry =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; bytes: Uint8Array };

/**
 * A page left out because it couldn't be opened, or an attachment because
 * its file is gone (`missing`) or didn't open (`unreadable`). An
 * attachment's `path` is where it would have been: its page's links still
 * name it there.
 */
export type ExportSkipped =
  | { spaceId: SpaceId; pageId: PageId }
  | {
      spaceId: SpaceId;
      pageId: PageId;
      attachmentId: string;
      path: string;
      reason: 'missing' | 'unreadable';
    };

/** What an export wrote, and what it left out. */
export type ExportSummary = {
  pages: { spaceId: SpaceId; pageId: PageId; path: string }[];
  attachments: { spaceId: SpaceId; pageId: PageId; attachmentId: string; path: string }[];
  skipped: ExportSkipped[];
  /** Pages written as they were, their links not rewritten, because they couldn't be read. */
  unread: { spaceId: SpaceId; pageId: PageId; path: string }[];
};

/** The vault locked, access changed, or the caller gave up while exporting. */
export class ExportAbandoned extends Error {
  constructor() {
    super('Export stopped');
    this.name = 'ExportAbandoned';
  }
}

/** Pages opened at a time, so progress moves while a large space is opened. */
const CHUNK = 100;
/** Attachments downloaded at once. */
const IN_FLIGHT = 4;

/** The folder a space without a name it can open goes in: one only shared in part. */
const SHARED = 'Shared with me';

/** The folder a space they hold goes in when its name fails its checks. */
const UNREADABLE_SPACE = 'Unreadable space';

const nameOf = (loaded: LoadedMetadata | null) =>
  loaded?.opened.kind === 'current' ? loaded.opened.metadata.name : null;

/**
 * Export what this person (or agent) can read as Markdown files
 * (`planExport`), each page from the version they see (`shownVersions`),
 * as search indexes it: readers the publication, editors the draft, and a
 * copy unpublished where it is its last publication. A page that doesn't
 * open is left out and listed in `skipped`, and so is an attachment whose
 * file the server doesn't have or that doesn't open; anything else that
 * fails (no connection, signed out, the server failing) fails the export,
 * and no more attachments are downloaded or written.
 *
 * `scope` exports one space, or one of its folders, at the top of the
 * export. Without it, every space listed as held or shared with this person
 * goes in a folder of its own, by name, skipping one gone by the time it is
 * loaded or failing its checks.
 *
 * `checkSize` gets what the export will hold: the folders and pages its
 * trees list in scope once they are loaded, their paths not yet known,
 * then every folder and file once its pages are opened, attachments by the
 * size their pages list.
 * Throwing stops it before anything more is opened or written. `write`
 * gets each folder before what is in it, then each page and attachment as
 * it is ready. If the revision cache is cleared (the vault locks, or
 * access changes) or `signal` aborts, it stops with `ExportAbandoned`, at
 * the next page or file, and the caller drops what it was given. Writing
 * pages' Markdown, the longest part without a request, lets the event loop
 * run between pages (`pace`), so a page using it stays responsive. Each
 * page's links are read with `read`, by default here (`linkSpans`); some
 * text takes that far longer than its size suggests (#47), so the web app
 * reads them in a worker with a time limit. A page whose read fails or
 * throws is exported as written.
 */
export async function exportMarkdown(
  ctx: ClientContext,
  {
    scope,
    write,
    checkSize,
    onProgress,
    signal,
    read = async (markdown) => linkSpans(markdown),
  }: {
    scope?: ExportScope;
    write: (entry: ExportEntry) => void | Promise<void>;
    checkSize?: (size: ExportSize) => void;
    onProgress?: (progress: ExportProgress) => void;
    signal?: AbortSignal;
    read?: (markdown: string) => Promise<LinkSpans>;
  },
): Promise<ExportSummary> {
  const generation = ctx.revisions.generation;
  const live = () => {
    if (signal?.aborted || ctx.revisions.generation !== generation) throw new ExportAbandoned();
  };
  const ids = scope ? [scope.spaceId] : await readableSpaces(ctx);
  live();
  const loaded = (
    await Promise.all(
      ids.map(async (spaceId) => {
        try {
          return { spaceId, ...(await loadStructure(ctx, spaceId)) };
        } catch (error) {
          if (!scope && (error instanceof CryptoError || unreachable(error))) return null;
          throw error;
        }
      }),
    )
  ).filter((space) => space !== null);
  live();
  const root = scope?.folderId;
  if (root !== undefined && !loaded.some(({ folders }) => folders.some((f) => f.id === root))) {
    throw new ApiError(404, 'not-found', 'That folder is not in the space');
  }
  const top = root ?? null;
  const inScopeOf = (folders: readonly { id: string; parentId: string | null }[]) =>
    root === undefined ? () => true : inside(folders, root);
  // Before opening anything: each folder and page the trees list in scope, and each space's folder.
  checkSize?.({
    entries: loaded.reduce(
      (sum, { folders, pages }) => {
        const inScope = inScopeOf(folders);
        const count = (nodes: readonly { id: string; parentId: string | null }[]) =>
          nodes.filter((node) => node.id !== top && inScope(node.parentId)).length;
        return sum + count(folders) + count(pages);
      },
      scope ? 0 : loaded.length,
    ),
    bytes: 0,
    pathBytes: 0,
    longestPath: 0,
  });

  const total = loaded.reduce((sum, space) => sum + space.pages.length, 0);
  let done = 0;
  onProgress?.({ phase: 'pages', done, total });
  const spaces: (ExportSpace & { spaceId: SpaceId; versions: Map<string, OpenedRevision> })[] = [];
  const skipped: ExportSummary['skipped'] = [];
  for (const { spaceId, space, folders, pages } of loaded) {
    const versions = new Map<string, OpenedRevision>();
    for (let at = 0; at < pages.length; at += CHUNK) {
      const chunk = pages.slice(at, at + CHUNK);
      for (const [pageId, version] of await shownVersions(ctx, spaceId, chunk)) {
        if (version?.opened.kind === 'current') versions.set(pageId, version);
      }
      live();
      done += chunk.length;
      onProgress?.({ phase: 'pages', done, total });
    }
    const titled = pages.map((page) => {
      const opened = versions.get(page.id)?.opened;
      return { ...page, title: opened?.kind === 'current' ? opened.payload.title : null };
    });
    const linkable = linkablePages({ folders, pages: titled });
    const inScope = inScopeOf(folders);
    const exported: ExportFolder[] = folders
      .filter((folder) => folder.id !== top && inScope(folder.parentId))
      .map((folder) => ({
        id: folder.id,
        parentId: folder.parentId === top ? null : folder.parentId,
        name: nameOf(folder.metadata),
      }));
    const exportedPages: ExportPage[] = [];
    for (const page of pages) {
      if (!inScope(page.parentId)) continue;
      const opened = versions.get(page.id)?.opened;
      if (opened?.kind !== 'current') {
        skipped.push({ spaceId, pageId: page.id });
        continue;
      }
      exportedPages.push({
        id: page.id,
        parentId: page.parentId === top ? null : page.parentId,
        payload: opened.payload,
      });
    }
    spaces.push({
      spaceId,
      versions,
      dir: scope ? null : space ? (nameOf(space.metadata) ?? UNREADABLE_SPACE) : SHARED,
      folders: exported,
      pages: exportedPages,
      linkable,
    });
  }

  const planning = planningExport(spaces);
  let step = planning.next();
  while (!step.done) {
    if ('progress' in step.value) {
      onProgress?.({ phase: 'preparing', ...step.value.progress });
      await pace();
      live();
      step = planning.next();
      continue;
    }
    let links: LinkSpans;
    try {
      links = await read(step.value.read);
    } catch (error) {
      // Stopped, or the page's links couldn't be read: exported as written.
      live();
      step = planning.throw(error);
      continue;
    }
    live();
    step = planning.next(links);
  }
  const plan = step.value;
  const encoder = new TextEncoder();
  const paths = [...plan.dirs, ...plan.files.map((file) => file.path)].map(
    (path) => encoder.encode(path).length,
  );
  checkSize?.({
    entries: paths.length,
    bytes: plan.files.reduce(
      (sum, file) =>
        sum + (file.kind === 'page' ? encoder.encode(file.markdown).length : file.ref.size),
      0,
    ),
    pathBytes: paths.reduce((sum, bytes) => sum + bytes, 0),
    longestPath: paths.reduce((longest, bytes) => Math.max(longest, bytes), 0),
  });
  for (const path of plan.dirs) {
    await write({ kind: 'dir', path });
    await pace();
    live();
  }
  const summary: ExportSummary = { pages: [], attachments: [], skipped, unread: [] };
  const pageIds = new Set<string>();
  const attachments: {
    file: Extract<ExportFile, { kind: 'attachment' }>;
    space: (typeof spaces)[number];
  }[] = [];
  for (const file of plan.files) {
    const space = spaces[file.space];
    if (!space) continue;
    const pageId = file.pageId as PageId;
    if (file.kind === 'page') {
      pageIds.add(`${file.space}\0${pageId}`);
      await write({ kind: 'file', path: file.path, bytes: encoder.encode(file.markdown) });
      summary.pages.push({ spaceId: space.spaceId, pageId, path: file.path });
      if (file.unread) summary.unread.push({ spaceId: space.spaceId, pageId, path: file.path });
      await pace();
      live();
    } else {
      attachments.push({ file, space });
    }
  }
  // Pages the tree couldn't place (a folder loop) were opened but not written.
  spaces.forEach((space, i) => {
    for (const page of space.pages) {
      if (!pageIds.has(`${i}\0${page.id}`)) {
        skipped.push({ spaceId: space.spaceId, pageId: page.id as PageId });
      }
    }
  });

  onProgress?.({ phase: 'attachments', done: 0, total: attachments.length });
  let downloaded = 0;
  let next = 0;
  // Once one fails the export, the others start nothing more, and what they
  // were downloading is dropped: the export has already failed.
  let failed = false;
  const download = async () => {
    for (let item = attachments[next++]; item && !failed; item = attachments[next++]) {
      const { file, space } = item;
      const pageId = file.pageId as PageId;
      const version = space.versions.get(pageId);
      if (!version) continue;
      const found = { spaceId: space.spaceId, pageId, attachmentId: file.ref.id, path: file.path };
      let bytes: Uint8Array | null = null;
      try {
        bytes = await readAttachment(
          ctx,
          { spaceId: space.spaceId, pageId },
          version.record.audience,
          file.ref,
        );
      } catch (error) {
        const reason = attachmentFailure(error);
        if (reason === null) throw error;
        if (failed) return;
        skipped.push({ ...found, reason });
      }
      if (failed) return;
      live();
      if (bytes !== null) {
        await write({ kind: 'file', path: file.path, bytes });
        summary.attachments.push(found);
      }
      if (failed) return;
      onProgress?.({ phase: 'attachments', done: ++downloaded, total: attachments.length });
    }
  };
  const worker = () =>
    download().catch((error: unknown) => {
      failed = true;
      throw error;
    });
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, attachments.length) }, worker));
  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  summary.attachments.sort(byPath);
  // Pages in the order found, then attachments by path, as they finish in any order.
  const skippedPages = skipped.filter((item) => !('attachmentId' in item));
  const skippedFiles = skipped.filter((item) => 'attachmentId' in item).sort(byPath);
  summary.skipped = [...skippedPages, ...skippedFiles];
  return summary;
}

/**
 * Why one attachment failed in a way only it does, or null for a failure
 * that is every attachment's: no answer, signed out, refused for too many
 * requests, or the server failing. The server answers not-found for a
 * file it lacks or this person may not read; one that doesn't open was
 * changed, or listed wrongly.
 */
function attachmentFailure(error: unknown): 'missing' | 'unreadable' | null {
  if (error instanceof CryptoError) return 'unreadable';
  if (error instanceof ApiError && error.status === 404) return 'missing';
  return null;
}

/** Whether a node under `parentId` is inside `root`, following the tree's parents. */
function inside(
  folders: readonly { id: string; parentId: string | null }[],
  root: string,
): (parentId: string | null) => boolean {
  const parents = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  return (parentId) => {
    const seen = new Set<string>();
    for (let id = parentId; id !== null && !seen.has(id); id = parents.get(id) ?? null) {
      if (id === root) return true;
      seen.add(id);
    }
    return false;
  };
}
