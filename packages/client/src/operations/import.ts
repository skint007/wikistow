import {
  importRoutes,
  pageRoutes,
  structureRoutes,
  systemRoutes,
  type FolderId,
  type PageId,
  type RevisionId,
  type RouteDef,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError, outcomeUnknown, type ApiClient, type CallInput } from '../api/client.ts';
import { utf8 } from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import type { ImportFile } from '../import-archive.ts';
import {
  FolderId as FolderIdSchema,
  newId,
  PageId as PageIdSchema,
  RevisionId as RevisionIdSchema,
} from '../ids.ts';
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
import { repairText } from '../json.ts';
import { foldTitle, linkablePages, pageIndex, pagesTitled } from '../links.ts';
import { pace } from '../pace.ts';
import {
  newPayload,
  PageTooLarge,
  revisePayload,
  type AttachmentRef,
  type PagePayload,
} from '../payload.ts';
import { resealAttachment, sealAttachment } from '../revision.ts';
import {
  attachmentTarget,
  createPage,
  loadPage,
  publishPage,
  saveDraft,
  shownVersions,
  uploadBlob,
  type OpenedRevision,
  type PageRef,
} from './pages.ts';
import { spaceKeys } from './keys.ts';
import { patient, pause } from './patience.ts';
import type { treeTarget } from './records.ts';
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

/**
 * The vault locked, access changed, or the caller gave up while importing.
 * `unfinished` pages were made and left empty, unpublished drafts: running
 * the same import again into the same place finishes them.
 */
export class ImportStopped extends Error {
  readonly unfinished: number;
  constructor(unfinished = 0) {
    super('Import stopped');
    this.name = 'ImportStopped';
    this.unfinished = unfinished;
  }
}

/** Pages opened at a time when looking for an earlier run's. */
const CHUNK = 100;
/**
 * A page's attachments uploaded at once, each's two copies one after the
 * other. The server takes 4 uploads at once from an account, its agents'
 * too, so this leaves room for the person's own; more would also soon
 * reach its 400 uploads a minute, which `patient` waits out.
 */
const ATTACHMENTS_AT_ONCE = 2;
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
 * there. First every folder, then every page, so each link has a page to
 * resolve to: empty, unless its note names no other note and no file,
 * when it is made with its body and published at once. Then each empty
 * page's attachments are uploaded, a few at once, and its body saved with
 * its link table, as `page draft` does, and each page is published. A
 * Markdown link to another note becomes a wikilink, with as many of the
 * folders above its page as it takes to name it alone
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
 * It sends as few requests as it can. Where the server takes them
 * (`importBatches`), its folders, and its pages' creates, saves and
 * publishes, go in batches (`importRoutes.batch`), each one change that
 * lands whole or not at all; else each in a request of its own, as before
 * the route (`oneByOne`). Either way it asks where to write once a folder
 * it didn't make (`targetsByFolder`), and publishes from the draft it just
 * wrote, each attachment's copy for readers sealed from the file it read.
 * Each change goes with an `Idempotency-Key`, and one whose answer was lost
 * is sent again (`onceEach`).
 *
 * It waits out the server's rate limits (`patient`). Stops with
 * `ImportStopped` if `signal` aborts or the revision cache is cleared (the
 * vault locks, or access changes): after the request in flight, before the
 * next, so what was sealed for a batch not yet sent isn't made. The person
 * must be able to edit and publish at `scope`; else it is refused
 * (`forbidden`) before anything is made. A note over the page size limit
 * is left out, and so are encrypted notes; any other failure fails the
 * import, and running it again goes on from there. Progress counts each
 * folder and page as it lands.
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
  // Pages made, or left by an earlier run, to publish, and how many of them are done.
  const placed: Placed[] = [];
  const stopped = () => new ImportStopped(placed.filter((p) => p.empty).length);
  // Hundreds of notes take longer than the server's write limits allow at once.
  ctx = onceEach(patient(ctx, stopped, signal), stopped, signal);
  const { spaceId } = scope;
  const batched = await importBatches(ctx);
  const held = batched ? holding(ctx) : null;
  const targets = targetsByFolder(held?.ctx ?? ctx, spaceId);
  ctx = targets.ctx;
  // Once more if where to write, or who may read there, changed since the
  // server last said, as the server or this app found: asking it afresh.
  // `step` is told it is a retry, to trust nothing it kept.
  const again: Again = async (step) => {
    try {
      return await step(false);
    } catch (error) {
      if (!movedOn(error)) throw error;
      targets.forget();
      return step(true);
    }
  };

  // A draft this run just wrote, as it wrote it, from memory.
  const writtenDraft = (pageId: PageId, revisionId: RevisionId) =>
    ctx.revisions.get({ spaceId, pageId, audience: 'draft', revisionId });
  const generation = ctx.revisions.generation;
  const live = () => {
    if (signal?.aborted || ctx.revisions.generation !== generation) throw stopped();
  };
  const writes = held
    ? inBatches(ctx, held, { spaceId, forget: targets.forget, live })
    : oneByOne(ctx, again);
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
  // Each folder's ID, set once it is sealed: a folder in it may go in the same batch.
  const folderOf = new Map<string, FolderId>();
  const parentOf = (key: string | null) => (key === null ? root : (folderOf.get(key) ?? root));
  let folders = 0;
  const { folders: sourceFolders } = source;
  let foldersDone = 0;
  const folderLanded = () =>
    onProgress?.({ phase: 'folders', done: ++foldersDone, total: sourceFolders.length });
  onProgress?.({ phase: 'folders', done: 0, total: sourceFolders.length });
  for (const folder of sourceFolders) {
    const parentId = parentOf(folder.parent);
    const earlier = earlierFolders.get(placedAt(parentId, folder.key));
    if (earlier !== undefined) {
      folderOf.set(folder.key, earlier);
      // In order: after the folders sealed before it.
      await writes.add(async () => folderLanded);
      continue;
    }
    live();
    // The same ID each time it is sealed, so what goes in it names it.
    const folderId = newId(FolderIdSchema);
    folderOf.set(folder.key, folderId);
    await writes.add(async (w) => {
      await w.again(() =>
        createFolder(w.ctx, {
          spaceId,
          parentId,
          folderId,
          name: folderName(folder.name),
          extensions: importMark(from, folder.key),
        }),
      );
      return () => {
        folders++;
        folderLanded();
      };
    });
  }
  await writes.flush();
  live();

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
  const pageOf = new Map<string, PageId>();
  const linksOf = new Map<string, NoteLink[]>();
  // The draft an earlier run saved, by note: what it holds says what that run left.
  const savedBefore = new Map<string, { markdown: string; attachments: AttachmentRef[] }>();
  const summary: ImportSummary = {
    folders: 0,
    pages: [],
    existing: 0,
    attachments: 0,
    unresolved: [],
    skipped,
    encrypted: source.encrypted,
  };
  let pagesDone = 0;
  const pageLanded = () => onProgress?.({ phase: 'pages', done: ++pagesDone, total: notes.length });
  onProgress?.({ phase: 'pages', done: 0, total: notes.length });
  for (const note of notes) {
    live();
    const parentId = parentOf(note.parent);
    if (utf8(note.markdown).length > pageRoutes.MAX_MARKDOWN_BYTES) {
      skipped.push({ path: note.path, reason: 'too-large' });
      await writes.add(async () => pageLanded);
      continue;
    }
    const links = noteLinks(note, source);
    linksOf.set(note.key, links);
    const earlier = earlierPages.get(placedAt(parentId, note.key));
    if (earlier) {
      const { pageId } = earlier;
      pageOf.set(note.key, pageId);
      const { opened } = earlier.draft;
      if (opened.kind === 'current') savedBefore.set(note.key, opened.payload);
      // An earlier run cut short after saving the body has only to publish it.
      const empty =
        opened.kind !== 'current' ||
        (opened.payload.markdown === '' && opened.payload.attachments.length === 0);
      await writes.add(async () => () => {
        if (earlier.done) summary.existing++;
        else placed.push({ note, pageId, draft: earlier.draft, empty, written: undefined });
        pageLanded();
      });
      continue;
    }
    // The same IDs each time it is sealed, so links to it name it.
    const pageId = newId(PageIdSchema);
    const revisionId = newId(RevisionIdSchema);
    pageOf.set(note.key, pageId);
    // A note that names no other note or file reads the same whatever
    // the other pages are, so its page is made with its body at once, and
    // published with it.
    const whole =
      links.length === 0 && !note.markdown.includes('[[') && !repairText(note.markdown).repaired;
    await writes.add(async (w) => {
      const make = (markdown: string) =>
        w.again(() =>
          createPage(w.ctx, {
            spaceId,
            parentId,
            title: titleOf(note),
            markdown,
            extensions: importMark(from, note.key),
            pageId,
            revisionId,
          }),
        );
      let empty = !whole || note.markdown === '';
      try {
        await make(empty ? '' : note.markdown);
      } catch (error) {
        // Too large with the rest of its payload: made empty, and left out when saved.
        if (empty || !(error instanceof PageTooLarge)) throw error;
        await make('');
        empty = true;
      }
      const written = writtenDraft(pageId, revisionId);
      if (empty) {
        return () => {
          placed.push({ note, pageId, draft: null, empty, written });
          pageLanded();
        };
      }
      // Made with its body, from the draft just sealed: one fetched would be
      // the server's only once this lands, on its own.
      await w.again((retry) =>
        publishPage(
          w.ctx,
          { spaceId, pageId },
          {
            expected: { draftHead: revisionId, publishedHead: null },
            ...(written && (w.held || !retry) ? { draft: written } : {}),
          },
        ),
      );
      return () => {
        summary.pages.push({ path: note.path, pageId, title: titleOf(note) });
        pageLanded();
      };
    });
    await pace();
  }
  await writes.flush();
  live();

  // Every page there now, with its title, for links to resolve against.
  // Each publication goes in it as it is sealed: one into a share names
  // only pages already published there (`writeLinks`).
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

  // Links left as written, by note: by this run as it saves the note, or
  // by an earlier one, as its saved draft still holds them.
  const unresolvedOf = new Map<string, string[]>();
  for (const note of notes) {
    const saved = savedBefore.get(note.key);
    if (saved === undefined) continue;
    const links = linksOf.get(note.key) ?? [];
    unresolvedOf.set(note.key, leftAsWritten(note, links, saved, { resolves }));
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
  let saved = 0;
  onProgress?.({ phase: 'saving', done: 0, total: placed.length });
  for (const entry of placed) {
    live();
    const { note, pageId, draft } = entry;
    const page = { spaceId, pageId };
    const heads = listed.get(pageId);
    if (!heads?.draftHead) throw new ApiError(404, 'not-found', 'An imported page is gone');
    const { draftHead: basedOn, publishedHead } = heads;
    // Its body as it is to be saved, with its files uploaded: once, however
    // often it is sealed.
    let body: { payload: PagePayload; unresolved: string[] } | null = null;
    let copies: ReadonlyMap<AttachmentRef['id'], AttachmentRef> | undefined;
    if (entry.empty) {
      const opened = draft?.opened.kind === 'current' ? draft.opened.payload : null;
      const links = linksOf.get(note.key) ?? [];
      const uploaded = await uploadFiles(ctx, page, filesOf(links, source), live);
      summary.attachments += uploaded.length;
      const attached = new Map(uploaded.map((file) => [file.key, file.draft]));
      copies = new Map(uploaded.map((file) => [file.draft.id, file.readers]));
      const attachments = uploaded.map((file) => file.draft);
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
        ? revisePayload(draft.opened, { markdown, attachments: onPage })
        : newPayload({
            title: titleOf(note),
            markdown,
            attachments,
            extensions: importMark(from, note.key),
          });
      body = { payload, unresolved };
    }
    await writes.add(async (w) => {
      let draftHead = basedOn;
      let { written } = entry;
      // Whether `written` was sealed in this go: held with this publish, it is the only copy.
      let sealedHere = false;
      if (body) {
        try {
          const wrote = await w.again(() =>
            saveDraft(w.ctx, {
              page,
              basedOn,
              ...(heads.region ? { basedOnRegion: heads.region } : {}),
              payload: body.payload,
              tree,
            }),
          );
          draftHead = wrote.revisionId;
          written = writtenDraft(pageId, draftHead);
          sealedHere = true;
        } catch (error) {
          // Its links written out, longer than a page holds: left as an empty draft.
          if (!(error instanceof PageTooLarge)) throw error;
          return () => {
            skipped.push({ path: note.path, reason: 'too-large' });
            entry.empty = false;
            savedLanded();
          };
        }
      }
      // The draft this run made or saved is published as it wrote it,
      // without fetching it. One an earlier run saved is fetched: its region
      // as kept may be older than a share made since, as on a retry, unless
      // it was sealed with this publish and is not the server's yet.
      const published = await w.again((retry) =>
        publishPage(w.ctx, page, {
          tree,
          expected: { draftHead, publishedHead },
          ...(written && (!retry || (w.held && sealedHere)) ? { draft: written } : {}),
          ...(copies ? { copies } : {}),
        }),
      );
      // So pages published after it may name it, in this batch or the next.
      heads.publishedHead = published.revisionId;
      return () => {
        if (body) unresolvedOf.set(note.key, body.unresolved);
        entry.empty = false;
        entry.written = undefined;
        summary.pages.push({ path: note.path, pageId, title: titleOf(note) });
        savedLanded();
      };
    });
    await pace();
  }
  await writes.flush();
  live();
  summary.folders = folders;
  // In the export's order, whichever pass published each.
  const order = new Map(notes.map((note, i) => [note.path, i]));
  summary.pages.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  summary.unresolved = notes.flatMap((note) =>
    (unresolvedOf.get(note.key) ?? []).map((link) => ({ path: note.path, link })),
  );
  return summary;

  function savedLanded() {
    onProgress?.({ phase: 'saving', done: ++saved, total: placed.length });
  }
}

/**
 * A page to publish: made by this run, or left by an earlier one with
 * `draft`. `empty` while its body is still to save. `written` is the draft
 * this run made or saved, as it wrote it, kept here as the revision cache
 * may drop it before its turn to publish.
 */
type Placed = {
  note: SourceNote;
  pageId: PageId;
  draft: OpenedRevision | null;
  empty: boolean;
  written: OpenedRevision | undefined;
};

/** A file of the export to attach, by the key its links name it by. */
type Attaching = { key: string; name: string; mediaType: string; file: ImportFile };

/**
 * The files `links` name that the export has, each once, in order: at
 * most as many as a version lists (`MAX_ATTACHMENTS`). Links to the rest
 * stay as written.
 */
function filesOf(links: readonly NoteLink[], source: ImportSource): Attaching[] {
  const files = new Map<string, Attaching>();
  for (const link of links) {
    if (files.size === pageRoutes.MAX_ATTACHMENTS) break;
    if (link.kind !== 'resource' && link.kind !== 'file') continue;
    const found = source.files.get(link.key);
    if (found?.file && !files.has(link.key)) {
      const { name, mediaType, file } = found;
      files.set(link.key, { key: link.key, name, mediaType, file });
    }
  }
  return [...files.values()];
}

/** A file attached to a page: its copy for the draft, and its copy for readers. */
type Attached = { key: string; draft: AttachmentRef; readers: AttachmentRef };

/**
 * Upload `files` as attachments of `page`, a few at once
 * (`ATTACHMENTS_AT_ONCE`), listed in their order. Each is sealed for the
 * draft and sealed again for readers from the same bytes, and both copies
 * go up, so publishing needn't download it (`publishPage`'s `copies`). A file larger than the server takes is left out, so its
 * links stay as written. On a failure, or `live` throwing, the uploads
 * already sent finish first.
 */
async function uploadFiles(
  ctx: ClientContext,
  page: PageRef,
  files: readonly Attaching[],
  live: () => void,
): Promise<Attached[]> {
  const done: (Attached | undefined)[] = [];
  const queue = files.entries();
  // Failures in the order they came: the others stop at the first.
  const failures: unknown[] = [];
  const upload = async () => {
    for (const [at, { key, name, mediaType, file }] of queue) {
      if (failures.length > 0) return;
      const bytes = await file.read();
      const forDraft = attachmentTarget(ctx, page, 'draft');
      const draft = sealAttachment({ target: forDraft, name, mediaType, bytes });
      const readers = resealAttachment({
        from: forDraft,
        to: attachmentTarget(ctx, page, 'published'),
        ...draft,
      });
      try {
        await uploadBlob(ctx, page, 'draft', draft.blob);
        await uploadBlob(ctx, page, 'published', readers.blob);
        done[at] = { key, draft: draft.ref, readers: readers.ref };
      } catch (error) {
        // A file larger than the server takes is left out; any other failure stops the import.
        if (!(error instanceof ApiError && error.code === 'payload-too-large')) throw error;
      }
      live();
    }
  };
  const workers = Array.from({ length: Math.min(ATTACHMENTS_AT_ONCE, files.length) }, () =>
    upload().catch((error: unknown) => {
      failures.push(error);
    }),
  );
  await Promise.all(workers);
  if (failures.length > 0) throw failures[0];
  // In the order given, without the files left out.
  return done.filter((file) => file !== undefined);
}

/**
 * Whether a write failed because where it goes changed since the server
 * said: access (`permission-version`), its share (`region-mismatch`) or the
 * share's keys (`key-version`), as the server refused it or this app found
 * before sending it.
 */
const movedOn = (error: unknown) =>
  (error instanceof ApiError && error.code === 'permission-version') ||
  ((error instanceof ApiError || error instanceof CryptoError) &&
    (error.code === 'region-mismatch' || error.code === 'key-version'));

/**
 * Whether the server refused a write for the space's keys as this app had
 * them: a newer key version, or other owners (`withFreshKeys`).
 */
const staleKeys = (error: unknown) =>
  error instanceof ApiError &&
  (error.code === 'key-version' || error.code === 'recipients-mismatch');

/** The changes an import sends that take an `Idempotency-Key`. */
const KEYED: ReadonlySet<RouteDef> = new Set([
  structureRoutes.createFolder,
  pageRoutes.createPage,
  pageRoutes.saveDraft,
  pageRoutes.publish,
  importRoutes.batch,
]);
/** How long a change whose answer was lost waits before it is sent again, each time. */
const RESEND_AFTER_MS = [1000, 3000];

/**
 * `ctx` sending each change that takes one (`KEYED`) with an
 * `Idempotency-Key` of its own. When no answer comes back, or the server
 * failed (`outcomeUnknown`), it sends the same bytes again under the same
 * key, after each of `RESEND_AFTER_MS`: if the first was made, the server
 * answers as it did then, so no folder, page or version is made twice. A
 * wait ends early, throwing `stopped()`, if `signal` aborts.
 */
function onceEach(ctx: ClientContext, stopped: () => Error, signal?: AbortSignal): ClientContext {
  const { api } = ctx;
  const call = (async (...args: Parameters<ApiClient['call']>) => {
    const [route, input, options] = args;
    if (!KEYED.has(route) || options?.idempotencyKey !== undefined) return api.call(...args);
    const keyed = { ...options, idempotencyKey: `import:${crypto.randomUUID()}` };
    for (const wait of RESEND_AFTER_MS) {
      try {
        return await api.call(route, input, keyed);
      } catch (error) {
        if (!outcomeUnknown(error)) throw error;
        await pause(wait, stopped, signal);
      }
    }
    return api.call(route, input, keyed);
  }) as ApiClient['call'];
  return { ...ctx, api: { ...api, call } };
}

/** Whether the server takes an import's writes in batches (`importRoutes.batch`). */
async function importBatches(ctx: ClientContext): Promise<boolean> {
  const { importBatches = false } = await ctx.api.call(systemRoutes.installation);
  return importBatches;
}

/** `again` for one write: `step` is told whether it is sent again, sealed afresh. */
type Again = <T>(step: (retry: boolean) => Promise<T>) => Promise<T>;

/**
 * How an item's writes go: `ctx` to write through, `again` around each
 * write, and whether they are `held`, to be sent in the item's batch rather
 * than at once, so a draft written is not the server's until it lands.
 */
type Writing = { ctx: ClientContext; again: Again; held: boolean };

/**
 * One thing an import writes, a folder or a page, as far as it can at once:
 * it seals and writes it, through `writing`, and gives what follows once
 * that lands. It may be sealed again, with fresh keys, before that: so it
 * changes nothing else until then, but for what the next item reads.
 */
type Item = (writing: Writing) => Promise<() => void>;

/** Where an import's items go: `add` each, in order, and `flush` to send what waits. */
type Writes = { add: (item: Item) => Promise<void>; flush: () => Promise<void> };

/** Each item's writes sent at once, one request each, as a server before batches takes them. */
function oneByOne(ctx: ClientContext, again: Again): Writes {
  return {
    add: async (item) => (await item({ ctx, again, held: false }))(),
    flush: async () => {},
  };
}

type BatchBody = CallInput<typeof importRoutes.batch>['body'];
type BatchPage = BatchBody['pages'][number];

/** The writes one item sealed: a folder's, or one page's steps. */
type Held = { folders: BatchBody['folders']; pages: BatchPage[] };

/**
 * `ctx` holding back the writes a batch takes (`importRoutes.batch`):
 * making a folder, and making, saving and publishing a page, each answered
 * at once as the server answers it once it lands, the IDs being the
 * client's. `take` hands over what was held since it was last called, and
 * `send` sends writes taken as one batch, through `ctx`.
 */
function holding(ctx: ClientContext) {
  const { api } = ctx;
  let held: Held = { folders: [], pages: [] };
  const pageOf = (pageId: BatchPage['pageId']): BatchPage => {
    let page = held.pages.find((p) => p.pageId === pageId);
    if (!page) {
      page = { pageId, create: null, draft: null, publish: null };
      held.pages.push(page);
    }
    return page;
  };
  const call = (async (...args: Parameters<ApiClient['call']>) => {
    const [route, input] = args;
    if (route === structureRoutes.createFolder) {
      const { body } = input as CallInput<typeof structureRoutes.createFolder>;
      held.folders.push(body);
      return { folderId: body.folderId };
    }
    if (route === pageRoutes.createPage) {
      const { body } = input as CallInput<typeof pageRoutes.createPage>;
      const { pageId, ...create } = body;
      pageOf(pageId).create = create;
      return { pageId, revisionId: create.revision.record.revisionId };
    }
    if (route === pageRoutes.saveDraft) {
      const { params, body } = input as CallInput<typeof pageRoutes.saveDraft>;
      const { restoredFrom = null, ...draft } = body;
      // An import never restores: a restore goes alone.
      if (restoredFrom !== null) return api.call(...args);
      pageOf(params.pageId).draft = draft;
      return { revisionId: draft.revision.record.revisionId, replayed: false };
    }
    if (route === pageRoutes.publish) {
      const { params, body } = input as CallInput<typeof pageRoutes.publish>;
      pageOf(params.pageId).publish = body;
      return { revisionId: body.revision.record.revisionId, replayed: false };
    }
    return api.call(...args);
  }) as ApiClient['call'];
  return {
    ctx: { ...ctx, api: { ...api, call } },
    take(): Held {
      const taken = held;
      held = { folders: [], pages: [] };
      return taken;
    },
    async send(spaceId: SpaceId, taken: readonly Held[]): Promise<void> {
      const body: BatchBody = {
        folders: taken.flatMap((h) => h.folders),
        pages: taken.flatMap((h) => h.pages),
      };
      if (body.folders.length + body.pages.length === 0) return;
      await api.call(importRoutes.batch, { params: { spaceId }, body });
    },
  };
}

/**
 * Items' writes held (`holding`) and sent in batches of up to
 * `MAX_BATCH_FOLDERS` folders and `MAX_BATCH_PAGES` pages, and about
 * `BATCH_BYTES`, but always one item, each batch one change on the server.
 * An item, or a batch, refused because where it goes moved on (`movedOn`)
 * is sealed again with fresh answers (`forget`), and sent once more; a
 * batch also with the space's keys worked out again, as when it was
 * refused for them (`staleKeys`). Once a batch lands, its items'
 * follow-ups run, in order. `live` throws to stop before a batch is sent.
 */
function inBatches(
  ctx: ClientContext,
  held: ReturnType<typeof holding>,
  { spaceId, forget, live }: { spaceId: SpaceId; forget: () => void; live: () => void },
): Writes {
  type Sealed = { item: Item; writes: Held; bytes: number; landed: () => void };
  let batch: Sealed[] = [];
  const count = (sealed: readonly Sealed[]) => ({
    folders: sealed.reduce((n, s) => n + s.writes.folders.length, 0),
    pages: sealed.reduce((n, s) => n + s.writes.pages.length, 0),
    bytes: sealed.reduce((n, s) => n + s.bytes, 0),
  });
  const seal = async (item: Item, retry: boolean): Promise<Sealed> => {
    // What an item that failed partway held goes with it.
    held.take();
    const landed = await item({ ctx, again: (step) => step(retry), held: true });
    const writes = held.take();
    return { item, writes, bytes: JSON.stringify(writes).length, landed };
  };
  const sealOnce = async (item: Item) => {
    try {
      return await seal(item, false);
    } catch (error) {
      if (!movedOn(error)) throw error;
      // What is held goes first, so the server knows the folders it makes
      // before the answers that named them are forgotten.
      await flush();
      forget();
      return seal(item, true);
    }
  };
  const send = (sending: readonly Sealed[]) => {
    // Cancel, or a lock, stops before a batch goes, however late it was sealed.
    live();
    return held.send(
      spaceId,
      sending.map((s) => s.writes),
    );
  };
  const flush = async () => {
    let sending = batch;
    batch = [];
    if (sending.length === 0) return;
    try {
      await send(sending);
    } catch (error) {
      if (!movedOn(error) && !staleKeys(error)) throw error;
      // The single routes' writes are sealed again with the space's keys
      // worked out afresh when the server refuses them for those
      // (`withFreshKeys`); a batch's are refused only here, so the keys
      // are worked out again for it too, as a rotation or a change of
      // owners may come with the change of access that refused it.
      forget();
      await spaceKeys(ctx, spaceId, { refresh: true });
      const again: Sealed[] = [];
      for (const { item } of sending) again.push(await seal(item, true));
      sending = again;
      await send(sending);
    }
    for (const { landed } of sending) landed();
  };
  return {
    async add(item) {
      const sealed = await sealOnce(item);
      const next = count([...batch, sealed]);
      const over =
        next.folders > importRoutes.MAX_BATCH_FOLDERS ||
        next.pages > importRoutes.MAX_BATCH_PAGES ||
        next.bytes > importRoutes.BATCH_BYTES;
      if (batch.length > 0 && over) await flush();
      batch.push(sealed);
      const now = count(batch);
      if (
        now.folders >= importRoutes.MAX_BATCH_FOLDERS ||
        now.pages >= importRoutes.MAX_BATCH_PAGES
      ) {
        await flush();
      }
    },
    flush,
  };
}

type Target = Awaited<ReturnType<typeof treeTarget>>;

/**
 * `ctx` asking the server where to write (`treeTarget`) once for each
 * folder an import fills that it didn't make, rather than for every change.
 * A node takes the share of the folder it was made in, and its permission
 * version as it was then, so a folder or page this import makes gets the
 * answer its folder gave for making it: a folder with its name as made, a
 * page with none. Any other page is asked about once. The server still
 * checks each change against its own word. A refused change forgets every
 * answer, so the next change, or the same one sealed again with fresh keys,
 * asks again, and so does `forget`.
 */
function targetsByFolder(ctx: ClientContext, spaceId: SpaceId) {
  const { api } = ctx;
  // By node: a folder, the space (null), or a page; asked, or made here.
  const answers = new Map<string | null, Promise<Target>>();
  const ask = (nodeId: string | null) => {
    const known = answers.get(nodeId);
    if (known) return known;
    const asked = api.call(structureRoutes.target, {
      params: { spaceId },
      query: nodeId === null ? {} : { nodeId },
    });
    answers.set(nodeId, asked);
    asked.catch(() => {
      if (answers.get(nodeId) === asked) answers.delete(nodeId);
    });
    return asked;
  };
  // A node made in `parentId` with the answer it was made with, named `name`.
  const made = (nodeId: string, parentId: string | null, name: Target['name']) => {
    const parent = answers.get(parentId);
    if (parent)
      answers.set(
        nodeId,
        parent.then((target) => ({ ...target, name })),
      );
  };
  const call = (async (...args: Parameters<ApiClient['call']>) => {
    const [route, input] = args;
    if (route === structureRoutes.target) {
      const { params, query } = input as CallInput<typeof structureRoutes.target>;
      if (params.spaceId !== spaceId) return api.call(...args);
      return ask(query?.nodeId ?? null);
    }
    if (route === structureRoutes.createFolder) {
      const { params, body } = input as CallInput<typeof structureRoutes.createFolder>;
      if (params.spaceId === spaceId) {
        const { metadata, envelopes, wrap } = body;
        made(
          body.folderId,
          body.parentId,
          structureRoutes.ServedMetadata.parse({ metadata, envelopes, wrap }),
        );
      }
    } else if (route === pageRoutes.createPage) {
      const { params, body } = input as CallInput<typeof pageRoutes.createPage>;
      if (params.spaceId === spaceId) made(body.pageId, body.parentId, null);
    }
    try {
      return await api.call(...args);
    } catch (error) {
      if (KEYED.has(route) && error instanceof ApiError) forget();
      throw error;
    }
  }) as ApiClient['call'];
  function forget() {
    answers.clear();
  }
  return { ctx: { ...ctx, api: { ...api, call } }, forget };
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
