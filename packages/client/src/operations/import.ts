import { pageRoutes, type FolderId, type PageId, type SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { utf8 } from '../encoding.ts';
import {
  importFrom,
  importKeyOf,
  importMark,
  leftAsWritten,
  noteLinks,
  rewriteNote,
  wikilinkTarget,
  type ImportSource,
  type LinkRewrites,
  type NoteLink,
  type SourceNote,
} from '../import.ts';
import { foldTitle, linkablePages, pageIndex, pagesTitled } from '../links.ts';
import { pace } from '../pace.ts';
import { newPayload, PageTooLarge, revisePayload, type AttachmentRef } from '../payload.ts';
import {
  createPage,
  loadPage,
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

/**
 * A note or file left out, by where it is in the export, and why: a vault's
 * file no imported note links to or embeds is `unused`.
 */
export type ImportSkipped = { path: string; reason: 'encrypted' | 'too-large' | 'unused' };

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
  /** Links left as written, by note: by this run, or as an earlier run's saved draft still holds them. */
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
const titleOf = (note: SourceNote) => note.title || 'Untitled';

// Where an earlier run put something: its folder, and its key.
const placedAt = (parentId: FolderId | null, key: string) => `${parentId ?? ''}\0${key}`;

/**
 * Import a Joplin export (`readJoplinExport`) or an Obsidian vault
 * (`readObsidianVault`) into `scope`: a folder for each notebook or vault
 * folder, mirroring them, and a published page for each note, titled as
 * there. First every folder, then every page, empty, so each link has a
 * page to resolve to; then each page's attachments are uploaded and its
 * body saved with its link table, as `page draft` does, and it is
 * published. A Markdown link to another note becomes a wikilink, with as
 * many of the folders above its page as it takes to name it alone
 * (`wikilinkTarget`); a vault's wikilink changes so only when it wouldn't
 * name its page as written. A file's URL becomes `attachment:ID` on the
 * page that names it, and so does a vault's embed of it. A vault's files
 * that no imported note names are left out and reported.
 *
 * Each folder and page keeps its note's key (`importMark`), so running the
 * same import again into the same place changes nothing: a folder or page
 * of that key where it would go is used, one ever published left as it
 * is, even if someone unpublished it since, and one never published
 * finished. An import cut short is finished so.
 *
 * It waits out the server's rate limits (`patient`). Stops with
 * `ImportStopped`, at the next step, if `signal` aborts or the revision
 * cache is cleared (the vault locks, or access changes). The
 * person must be able to edit and publish at `scope`; else it is refused
 * (`forbidden`) before anything is made. A note over the page size limit
 * is left out, and so are encrypted notes; any other failure fails the
 * import, and running it again goes on from there.
 */
export async function importNotes(
  ctx: ClientContext,
  {
    scope,
    source,
    onProgress,
    signal,
  }: {
    scope: ImportScope;
    source: ImportSource;
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
  const from = importFrom(source.format);
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
    const key = opened?.kind === 'current' ? importKeyOf(opened.metadata.extensions, from) : null;
    if (key !== null) earlierFolders.set(placedAt(folder.parentId, key), folder.id);
  }
  const folderOf = new Map<string, FolderId>();
  const parentOf = (key: string | null) => (key === null ? root : (folderOf.get(key) ?? root));
  let folders = 0;
  const { folders: sourceFolders } = source;
  onProgress?.({ phase: 'folders', done: 0, total: sourceFolders.length });
  for (const [i, folder] of sourceFolders.entries()) {
    const parentId = parentOf(folder.parent);
    let folderId = earlierFolders.get(placedAt(parentId, folder.key));
    if (folderId === undefined) {
      folderId = await createFolder(ctx, {
        spaceId,
        parentId,
        name: folderName(folder.name),
        extensions: importMark(from, folder.key),
      });
      folders++;
      live();
    }
    folderOf.set(folder.key, folderId);
    onProgress?.({ phase: 'folders', done: i + 1, total: sourceFolders.length });
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
      const key = importKeyOf(version.opened.payload.extensions, from);
      if (key === null) continue;
      // Published once, it is done: one unpublished since was unpublished by someone.
      const done =
        page.publishedHead !== null || (await loadPage(ctx, page.id)).heads.publishedCount > 0;
      earlierPages.set(placedAt(page.parentId, key), { pageId: page.id, done, draft: version });
    }
  }

  const skipped: ImportSkipped[] = source.encryptedNotes.map((path) => ({
    path,
    reason: 'encrypted',
  }));
  const { notes } = source;
  const placed: { note: SourceNote; pageId: PageId; draft: OpenedRevision | null }[] = [];
  const pageOf = new Map<string, PageId>();
  // The draft an earlier run saved, by note: what it holds says what that run left.
  const savedBefore = new Map<string, { markdown: string; attachments: AttachmentRef[] }>();
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
        const { opened } = earlier.draft;
        if (opened.kind === 'current') savedBefore.set(note.key, opened.payload);
        if (earlier.done) existing++;
        else placed.push({ note, pageId, draft: earlier.draft });
      } else {
        pageId = await createPage(ctx, {
          spaceId,
          parentId,
          title: titleOf(note),
          extensions: importMark(from, note.key),
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
  const resolves: LinkRewrites['resolves'] = (target, key) => {
    const found = pagesTitled(target, linkable, index);
    return found.length === 1 && (key === null || found[0] === pageOf.get(key));
  };

  const summary: ImportSummary = {
    folders,
    pages: [],
    existing,
    attachments: 0,
    unresolved: [],
    skipped,
    encrypted: source.encrypted,
  };
  // Each note's links, and those left as written: by this run as it saves
  // the note, or by an earlier one, as its saved draft still holds them.
  const linksOf = new Map<string, NoteLink[]>();
  const unresolvedOf = new Map<string, string[]>();
  for (const note of notes) {
    if (!pageOf.has(note.key)) continue;
    const links = noteLinks(note, source);
    linksOf.set(note.key, links);
    const saved = savedBefore.get(note.key);
    if (saved !== undefined) {
      unresolvedOf.set(note.key, leftAsWritten(note, links, saved, { resolves }));
    }
    await pace();
  }
  // A vault's files belong to the pages that name them: the rest are left out.
  if (source.format === 'obsidian') {
    const named = new Set(
      [...linksOf.values()].flat().flatMap((link) => ('key' in link && link.key ? [link.key] : [])),
    );
    for (const key of source.files.keys()) {
      if (!named.has(key)) skipped.push({ path: key, reason: 'unused' });
    }
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
      const links = linksOf.get(note.key) ?? [];
      const attached = new Map<string, AttachmentRef>();
      for (const key of filesOf(links, source)) {
        const resource = source.files.get(key);
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
          // A file larger than the server takes: its links stay as written.
          if (!(error instanceof ApiError && error.code === 'payload-too-large')) throw error;
        }
        live();
      }
      const attachments = [...attached.values()];
      // The page's attachments once saved: an embed names one by its name.
      const onPage = [...(opened?.attachments ?? []), ...attachments];
      const { markdown, unresolved } = rewriteNote(note, links, {
        wikilink,
        attachment: (key) => {
          const ref = attached.get(key);
          const name = ref && foldTitle(ref.name);
          return (
            ref && {
              id: ref.id,
              alone: onPage.filter((a) => foldTitle(a.name) === name).length === 1,
            }
          );
        },
        resolves,
      });
      const payload = draft
        ? revisePayload(draft.opened, {
            markdown,
            attachments: onPage,
          })
        : newPayload({
            title: titleOf(note),
            markdown,
            attachments,
            extensions: importMark(from, note.key),
          });
      try {
        await saveDraft(ctx, {
          page,
          basedOn: heads.draftHead,
          ...(heads.region ? { basedOnRegion: heads.region } : {}),
          payload,
          tree,
        });
        unresolvedOf.set(note.key, unresolved);
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
  summary.unresolved = notes.flatMap((note) =>
    (unresolvedOf.get(note.key) ?? []).map((link) => ({ path: note.path, link })),
  );
  return summary;
}

/**
 * The files `links` name that the export has, each once, in order: at
 * most as many as a version lists (`MAX_ATTACHMENTS`). Links to the rest
 * stay as written.
 */
function filesOf(links: readonly NoteLink[], source: ImportSource): Set<string> {
  const files = new Set<string>();
  for (const link of links) {
    if (files.size === pageRoutes.MAX_ATTACHMENTS) break;
    if ((link.kind === 'resource' || link.kind === 'file') && source.files.get(link.key)?.file) {
      files.add(link.key);
    }
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
