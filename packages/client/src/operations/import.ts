import {
  pageRoutes,
  structureRoutes,
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
import { newId, PageId as PageIdSchema, RevisionId as RevisionIdSchema } from '../ids.ts';
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
import { newPayload, PageTooLarge, revisePayload, type AttachmentRef } from '../payload.ts';
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
 * when it is made with its body. Then each empty page's attachments are
 * uploaded, a few at once, and its body saved with its link table, as
 * `page draft` does, and each page is published. A Markdown link to
 * another note becomes a wikilink, with as many of the folders above its
 * page as it takes to name it alone
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
 * It sends as few requests as it can, one after another but for uploads:
 * it asks where to write once a folder (`targetsByFolder`), and publishes
 * from the draft it just saved, each attachment's copy for readers sealed
 * from the file it read. Each change goes with an `Idempotency-Key`, and
 * one whose answer was lost is sent again (`onceEach`).
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
  // Pages made, or left by an earlier run, to publish, and how many of them are done.
  const placed: Placed[] = [];
  let finished = 0;
  const stopped = () => new ImportStopped(placed.filter((p) => p.empty).length);
  // Hundreds of notes take longer than the server's write limits allow at once.
  ctx = onceEach(patient(ctx, stopped, signal), stopped, signal);
  const targets = targetsByFolder(ctx, scope.spaceId);
  ctx = targets.ctx;
  // Once more if where to write, or who may read there, changed since the
  // server last said, as the server or this app found: asking it afresh.
  // `step` is told it is a retry, to trust nothing it kept.
  const again = async <T>(step: (retry: boolean) => Promise<T>): Promise<T> => {
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
    ctx.revisions.get({ spaceId: scope.spaceId, pageId, audience: 'draft', revisionId });
  const generation = ctx.revisions.generation;
  const live = () => {
    if (signal?.aborted || ctx.revisions.generation !== generation) throw stopped();
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
      folderId = await again(() =>
        createFolder(ctx, {
          spaceId,
          parentId,
          name: folderName(folder.name),
          extensions: importMark(from, folder.key),
        }),
      );
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
  const pageOf = new Map<string, PageId>();
  const linksOf = new Map<string, NoteLink[]>();
  // The draft an earlier run saved, by note: what it holds says what that run left.
  const savedBefore = new Map<string, { markdown: string; attachments: AttachmentRef[] }>();
  let existing = 0;
  onProgress?.({ phase: 'pages', done: 0, total: notes.length });
  for (const [i, note] of notes.entries()) {
    const parentId = parentOf(note.parent);
    if (utf8(note.markdown).length > pageRoutes.MAX_MARKDOWN_BYTES) {
      skipped.push({ path: note.path, reason: 'too-large' });
    } else {
      const links = noteLinks(note, source);
      linksOf.set(note.key, links);
      const earlier = earlierPages.get(placedAt(parentId, note.key));
      let pageId: PageId;
      if (earlier) {
        pageId = earlier.pageId;
        const { opened } = earlier.draft;
        if (opened.kind === 'current') savedBefore.set(note.key, opened.payload);
        // An earlier run cut short after saving the body has only to publish it.
        const empty =
          opened.kind !== 'current' ||
          (opened.payload.markdown === '' && opened.payload.attachments.length === 0);
        if (earlier.done) existing++;
        else placed.push({ note, pageId, draft: earlier.draft, empty, written: undefined });
      } else {
        pageId = newId(PageIdSchema);
        const revisionId = newId(RevisionIdSchema);
        // A note that names no other note or file reads the same whatever
        // the other pages are, so its page is made with its body at once.
        const whole =
          links.length === 0 &&
          !note.markdown.includes('[[') &&
          !repairText(note.markdown).repaired;
        const make = (markdown: string) =>
          again(() =>
            createPage(ctx, {
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
        targets.made(pageId, parentId);
        live();
        placed.push({
          note,
          pageId,
          draft: null,
          empty,
          written: writtenDraft(pageId, revisionId),
        });
      }
      pageOf.set(note.key, pageId);
    }
    onProgress?.({ phase: 'pages', done: i + 1, total: notes.length });
    await pace();
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
  onProgress?.({ phase: 'saving', done: 0, total: placed.length });
  for (const [i, entry] of placed.entries()) {
    live();
    const { note, pageId, draft } = entry;
    const page = { spaceId, pageId };
    const heads = listed.get(pageId);
    if (!heads?.draftHead) throw new ApiError(404, 'not-found', 'An imported page is gone');
    let draftHead = heads.draftHead;
    let copies: ReadonlyMap<AttachmentRef['id'], AttachmentRef> | undefined;
    let tooLarge = false;
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
        const written = await again(() =>
          saveDraft(ctx, {
            page,
            basedOn: draftHead,
            ...(heads.region ? { basedOnRegion: heads.region } : {}),
            payload,
            tree,
          }),
        );
        draftHead = written.revisionId;
        entry.written = writtenDraft(pageId, draftHead);
        unresolvedOf.set(note.key, unresolved);
      } catch (error) {
        // Its links written out, longer than a page holds: left as an empty draft.
        if (!(error instanceof PageTooLarge)) throw error;
        skipped.push({ path: note.path, reason: 'too-large' });
        tooLarge = true;
      }
      entry.empty = false;
      live();
    }
    if (!tooLarge) {
      // The draft this run made or saved is published as it wrote it,
      // without fetching it. One an earlier run saved is fetched: its region
      // as kept may be older than a share made since, as on a retry.
      const { written } = entry;
      const { publishedHead } = heads;
      const published = await again((retry) =>
        publishPage(ctx, page, {
          tree,
          expected: { draftHead, publishedHead },
          ...(written && !retry ? { draft: written } : {}),
          ...(copies ? { copies } : {}),
        }),
      );
      heads.publishedHead = published.revisionId;
      entry.written = undefined;
      summary.pages.push({ path: note.path, pageId, title: titleOf(note) });
    }
    finished++;
    live();
    onProgress?.({ phase: 'saving', done: i + 1, total: placed.length });
    await pace();
  }
  summary.unresolved = notes.flatMap((note) =>
    (unresolvedOf.get(note.key) ?? []).map((link) => ({ path: note.path, link })),
  );
  return summary;
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

/** The changes an import sends that take an `Idempotency-Key`. */
const KEYED: ReadonlySet<RouteDef> = new Set([
  structureRoutes.createFolder,
  pageRoutes.createPage,
  pageRoutes.saveDraft,
  pageRoutes.publish,
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

type Target = Awaited<ReturnType<typeof treeTarget>>;

/**
 * `ctx` asking the server where to write (`treeTarget`) once for each
 * folder an import fills, rather than for every change. A page takes the
 * permission version of the folder it was made in, as it was then, and is
 * in its share, so a page this import made (`made`) gets the answer its
 * folder gave for making it, without the folder's name. Any other page is
 * asked about once. The server still checks each change against its own
 * word. A refused change forgets every answer, so the next change, or the
 * same one sealed again with fresh keys, asks again, and so does `forget`.
 */
function targetsByFolder(ctx: ClientContext, spaceId: SpaceId) {
  const { api } = ctx;
  // By node: a folder, the space (null), or a page asked about itself.
  const answers = new Map<string | null, Promise<Target>>();
  // By page this import made: the answer it was made with.
  const pinned = new Map<string, Promise<Target>>();
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
  const call = (async (...args: Parameters<ApiClient['call']>) => {
    const [route, input] = args;
    if (route === structureRoutes.target) {
      const { params, query } = input as CallInput<typeof structureRoutes.target>;
      if (params.spaceId !== spaceId) return api.call(...args);
      const nodeId = query?.nodeId ?? null;
      const madeWith = nodeId === null ? undefined : pinned.get(nodeId);
      if (madeWith === undefined) return ask(nodeId);
      return { ...(await madeWith), name: null } satisfies Target;
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
    pinned.clear();
  }
  return {
    ctx: { ...ctx, api: { ...api, call } },
    forget,
    /** `pageId` was just made in `parentId`, with the answer asked last for it. */
    made: (pageId: PageId, parentId: FolderId | null) => {
      const used = answers.get(parentId);
      if (used) pinned.set(pageId, used);
    },
  };
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
