import { pageRoutes, type FolderId, type PageId, type SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { utf8 } from '../encoding.ts';
import {
  importKeyOf,
  importMark,
  noteLinks,
  rewriteNote,
  wikilinkTarget,
  type JoplinExport,
  type JoplinNote,
  type NoteLink,
} from '../import.ts';
import { linkablePages, pageIndex } from '../links.ts';
import { pace } from '../pace.ts';
import { newPayload, PageTooLarge, revisePayload, type AttachmentRef } from '../payload.ts';
import {
  createPage,
  publishPage,
  saveDraft,
  shownVersions,
  uploadAttachment,
  type OpenedRevision,
} from './pages.ts';
import { patient } from './patience.ts';
import type { ClientContext } from './session.ts';
import { createFolder, loadStructure, loadTree } from './spaces.ts';

/** Where an import goes: the top of a space, or a folder of it. */
export type ImportScope = { spaceId: SpaceId; folderId?: FolderId };

/** Folders made, then pages made empty, then each page saved and published. */
export type ImportProgress = { phase: 'folders' | 'pages' | 'saving'; done: number; total: number };

/** A note left out, by where it is in the export, and why. */
export type ImportSkipped = { path: string; reason: 'encrypted' | 'too-large' };

/** What an import made, and what it couldn't. */
export type ImportSummary = {
  /** Folders this run made. */
  folders: number;
  /** Pages this run saved and published, made now or by an earlier run cut short. */
  pages: { path: string; pageId: PageId; title: string }[];
  /** Pages an earlier run of this import finished, left as they are. */
  existing: number;
  /** Attachments this run uploaded. */
  attachments: number;
  /** Links to notes or files no run can rewrite, left as written, by note. */
  unresolved: { path: string; link: string }[];
  skipped: ImportSkipped[];
  /** Encrypted items in a JEX, which Joplin must decrypt before exporting. */
  encrypted: number;
};

/** The vault locked, access changed, or the caller gave up while importing. */
export class ImportStopped extends Error {
  constructor() {
    super('Import stopped');
    this.name = 'ImportStopped';
  }
}

/** Pages opened at a time when looking for an earlier run's. */
const CHUNK = 100;
/** The longest name a folder takes. */
const FOLDER_NAME_LENGTH = 200;

const folderName = (name: string) => name.trim().slice(0, FOLDER_NAME_LENGTH).trim() || 'Untitled';
const titleOf = (note: JoplinNote) => note.title || 'Untitled';

// Where an earlier run put something: its folder, and its key.
const placedAt = (parentId: FolderId | null, key: string) => `${parentId ?? ''}\0${key}`;

/**
 * Import a Joplin export (`readJoplinExport`) into `scope`: a folder for
 * each notebook, mirroring them, and a published page for each note,
 * titled as in Joplin. First every folder, then every page, empty, so each
 * link has a page to resolve to; then each page's attachments are uploaded
 * and its body saved with its link table, as `page draft` does, and it is
 * published. A link to another note becomes a wikilink, with as many of
 * the folders above its page as it takes to name it alone (`wikilinkTarget`),
 * and a file's URL becomes `attachment:ID` on the page that names it.
 *
 * Each folder and page keeps its note's key (`importMark`), so running the
 * same import again into the same place changes nothing: a folder or page
 * of that key where it would go is used, a published one left as it is,
 * and an unpublished one finished. An import cut short is finished so.
 *
 * It waits out the server's rate limits (`patient`). Stops with
 * `ImportStopped`, at the next step, if `signal` aborts or the revision
 * cache is cleared (the vault locks, or access changes). The
 * person must be able to edit and publish at `scope`; else it is refused
 * (`forbidden`) before anything is made. A note over the page size limit
 * is left out, and so are encrypted notes; any other failure fails the
 * import, and running it again goes on from there.
 */
export async function importJoplin(
  ctx: ClientContext,
  {
    scope,
    joplin,
    onProgress,
    signal,
  }: {
    scope: ImportScope;
    joplin: JoplinExport;
    onProgress?: (progress: ImportProgress) => void;
    signal?: AbortSignal;
  },
): Promise<ImportSummary> {
  // Hundreds of notes take longer than the server's write limits allow at once.
  ctx = patient(ctx, () => new ImportStopped(), signal);
  const generation = ctx.revisions.generation;
  const live = () => {
    if (signal?.aborted || ctx.revisions.generation !== generation) throw new ImportStopped();
  };
  const { spaceId } = scope;
  const root = scope.folderId ?? null;
  const structure = await loadStructure(ctx, spaceId);
  live();
  if (root !== null && !structure.folders.some((folder) => folder.id === root)) {
    throw new ApiError(404, 'not-found', 'That folder is not in the space');
  }
  if (!mayPublishAt(structure, root)) {
    throw new ApiError(403, 'forbidden', 'Importing needs edit and publish rights there');
  }

  // Folders an earlier run made, by where they are and their key.
  const earlierFolders = new Map<string, FolderId>();
  for (const folder of structure.folders) {
    const opened = folder.metadata?.opened;
    const key = opened?.kind === 'current' ? importKeyOf(opened.metadata.extensions) : null;
    if (key !== null) earlierFolders.set(placedAt(folder.parentId, key), folder.id);
  }
  const folderOf = new Map<string, FolderId>();
  const parentOf = (key: string | null) => (key === null ? root : (folderOf.get(key) ?? root));
  let folders = 0;
  const { notebooks } = joplin;
  onProgress?.({ phase: 'folders', done: 0, total: notebooks.length });
  for (const [i, notebook] of notebooks.entries()) {
    const parentId = parentOf(notebook.parent);
    let folderId = earlierFolders.get(placedAt(parentId, notebook.key));
    if (folderId === undefined) {
      folderId = await createFolder(ctx, {
        spaceId,
        parentId,
        name: folderName(notebook.name),
        extensions: importMark(notebook.key),
      });
      folders++;
      live();
    }
    folderOf.set(notebook.key, folderId);
    onProgress?.({ phase: 'folders', done: i + 1, total: notebooks.length });
  }

  // Pages an earlier run made, in the folders this one fills.
  const filled = new Set<FolderId | null>([root, ...folderOf.values()]);
  const candidates = structure.pages.filter((page) => filled.has(page.parentId));
  const earlierPages = new Map<string, { pageId: PageId; done: boolean; draft: OpenedRevision }>();
  for (let at = 0; at < candidates.length; at += CHUNK) {
    const chunk = candidates.slice(at, at + CHUNK);
    const versions = await shownVersions(ctx, spaceId, chunk);
    live();
    for (const page of chunk) {
      const version = versions.get(page.id);
      if (version?.opened.kind !== 'current' || page.draftHead === null) continue;
      const key = importKeyOf(version.opened.payload.extensions);
      if (key === null) continue;
      const done = page.publishedHead !== null;
      earlierPages.set(placedAt(page.parentId, key), { pageId: page.id, done, draft: version });
    }
  }

  const skipped: ImportSkipped[] = joplin.encryptedNotes.map((path) => ({
    path,
    reason: 'encrypted',
  }));
  const { notes } = joplin;
  const placed: { note: JoplinNote; pageId: PageId; draft: OpenedRevision | null }[] = [];
  const pageOf = new Map<string, PageId>();
  let existing = 0;
  onProgress?.({ phase: 'pages', done: 0, total: notes.length });
  for (const [i, note] of notes.entries()) {
    const parentId = parentOf(note.parent);
    if (utf8(note.markdown).length > pageRoutes.MAX_MARKDOWN_BYTES) {
      skipped.push({ path: note.path, reason: 'too-large' });
    } else {
      const earlier = earlierPages.get(placedAt(parentId, note.key));
      let pageId: PageId;
      if (earlier) {
        pageId = earlier.pageId;
        if (earlier.done) existing++;
        else placed.push({ note, pageId, draft: earlier.draft });
      } else {
        pageId = await createPage(ctx, {
          spaceId,
          parentId,
          title: titleOf(note),
          extensions: importMark(note.key),
        });
        live();
        placed.push({ note, pageId, draft: null });
      }
      pageOf.set(note.key, pageId);
    }
    onProgress?.({ phase: 'pages', done: i + 1, total: notes.length });
  }

  // Every page there now, with its title, for links to resolve against.
  // Each publication goes in it as it is made: one into a share names only
  // pages already published there (`writeLinks`).
  const loaded = await loadTree(ctx, spaceId);
  live();
  const listed = new Map(loaded.pages.map((page) => [page.id, { ...page }]));
  const tree = { ...loaded, pages: [...listed.values()] };
  const linkable = linkablePages(tree);
  const index = pageIndex(linkable);
  const linkableById = new Map(linkable.map((page) => [page.id, page]));
  const wikilink = (key: string) => {
    const page = linkableById.get(pageOf.get(key) ?? '');
    const target = page && wikilinkTarget(page, linkable, index);
    return page?.title && target ? { target, title: page.title } : undefined;
  };

  const summary: ImportSummary = {
    folders,
    pages: [],
    existing,
    attachments: 0,
    unresolved: [],
    skipped,
    encrypted: joplin.encrypted,
  };
  // Each note's links, and those no run can rewrite, reported on every run,
  // so one finishing another's work lists them too.
  const linksOf = new Map<string, { links: NoteLink[]; files: Set<string> }>();
  for (const note of notes) {
    if (!pageOf.has(note.key)) continue;
    const links = noteLinks(note, joplin.target);
    const files = filesOf(links, joplin);
    linksOf.set(note.key, { links, files });
    const { unresolved } = rewriteNote(note, links, {
      wikilink,
      attachment: (key) => (files.has(key) ? key : undefined),
    });
    summary.unresolved.push(...unresolved.map((link) => ({ path: note.path, link })));
    await pace();
  }
  onProgress?.({ phase: 'saving', done: 0, total: placed.length });
  for (const [i, { note, pageId, draft }] of placed.entries()) {
    const page = { spaceId, pageId };
    const heads = listed.get(pageId);
    if (!heads?.draftHead) throw new ApiError(404, 'not-found', 'An imported page is gone');
    const opened = draft?.opened.kind === 'current' ? draft.opened.payload : null;
    // An earlier run cut short after saving the body has only to publish it.
    const saved = opened !== null && (opened.markdown !== '' || opened.attachments.length > 0);
    let tooLarge = false;
    if (!saved) {
      const { links = [], files = new Set<string>() } = linksOf.get(note.key) ?? {};
      const attached = new Map<string, AttachmentRef>();
      for (const key of files) {
        const resource = joplin.resources.get(key);
        if (!resource?.file) continue;
        const bytes = await resource.file.read();
        try {
          const ref = await uploadAttachment(ctx, page, {
            name: resource.name,
            mediaType: resource.mediaType,
            bytes,
          });
          attached.set(key, ref);
          summary.attachments++;
        } catch (error) {
          // A file larger than the server takes: its links stay as written,
          // reported by this run only, as no other knows the limit.
          if (!(error instanceof ApiError && error.code === 'payload-too-large')) throw error;
          summary.unresolved.push({ path: note.path, link: resource.name });
        }
        live();
      }
      const { markdown } = rewriteNote(note, links, {
        wikilink,
        attachment: (key) => attached.get(key)?.id,
      });
      const attachments = [...attached.values()];
      const payload = draft
        ? revisePayload(draft.opened, {
            markdown,
            attachments: [...(opened?.attachments ?? []), ...attachments],
          })
        : newPayload({
            title: titleOf(note),
            markdown,
            attachments,
            extensions: importMark(note.key),
          });
      try {
        await saveDraft(ctx, {
          page,
          basedOn: heads.draftHead,
          ...(heads.region ? { basedOnRegion: heads.region } : {}),
          payload,
          tree,
        });
      } catch (error) {
        // Its links written out, longer than a page holds: left as an empty draft.
        if (!(error instanceof PageTooLarge)) throw error;
        skipped.push({ path: note.path, reason: 'too-large' });
        tooLarge = true;
      }
      live();
    }
    if (!tooLarge) {
      heads.publishedHead = (await publishPage(ctx, page, { tree })).revisionId;
      summary.pages.push({ path: note.path, pageId, title: titleOf(note) });
      live();
    }
    onProgress?.({ phase: 'saving', done: i + 1, total: placed.length });
    await pace();
  }
  return summary;
}

/**
 * The files `links` name that the export has, each once, in order: at
 * most as many as a version lists (`MAX_ATTACHMENTS`). Links to the rest
 * stay as written.
 */
function filesOf(links: readonly NoteLink[], joplin: JoplinExport): Set<string> {
  const files = new Set<string>();
  for (const link of links) {
    if (files.size === pageRoutes.MAX_ATTACHMENTS) break;
    if (link.kind === 'resource' && joplin.resources.get(link.key)?.file) files.add(link.key);
  }
  return files;
}

/**
 * Whether the person may edit and publish under `parentId`: by the nearest
 * share at or above it they hold, else their standing in the space.
 */
function mayPublishAt(
  { space, shares, folders }: Awaited<ReturnType<typeof loadStructure>>,
  parentId: FolderId | null,
): boolean {
  const parents = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  const seen = new Set<FolderId>();
  for (let id = parentId; id !== null && !seen.has(id); id = parents.get(id) ?? null) {
    seen.add(id);
    const share = shares.find((s) => s.rootId === id);
    if (share) return share.role !== 'reader' && share.canPublish;
  }
  const top = shares.find((s) => s.rootId === null) ?? space;
  return top !== null && top.role !== 'reader' && top.canPublish;
}
