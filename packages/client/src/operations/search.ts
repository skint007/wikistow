import {
  FolderId,
  PageId,
  RevisionId,
  sharingRoutes,
  SpaceId,
  structureRoutes,
} from '@wikistow/contracts';
import { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { openOnDevice, sealOnDevice } from '../device-seal.ts';
import { canonical, decodeUtf8, utf8 } from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import { foldPropertyName, type PropertyData } from '../markdown/properties.ts';
import {
  hasTag,
  indexedContent,
  SearchIndex,
  type IndexedPage,
  type IndexedText,
} from '../search.ts';
import { shownVersions } from './pages.ts';
import type { LoadedMetadata, OpenedRevision } from './records.ts';
import type { ClientContext } from './session.ts';
import { loadStructure } from './spaces.ts';

/** A page as search lists it. */
export type SearchPage = {
  spaceId: SpaceId;
  pageId: PageId;
  /** The version whose title, text and properties are indexed. */
  revisionId: RevisionId;
  /** The folder it is directly in, or null at the space's top. */
  parentId: FolderId | null;
  /**
   * The folders it is in, outermost first, as far up as this person's tree
   * goes: those `path` names.
   */
  folderIds: FolderId[];
  /**
   * Where it is: the space's name, when this person holds the space, then
   * each folder's down to the page's, null where a name can't be opened.
   */
  path: (string | null)[];
  /**
   * The text indexed is a draft readers don't see: this person edits the
   * page, and it was never published or changed since.
   */
  draft: boolean;
  /**
   * The page is a copy unpublished where it is: readers don't see it, and
   * the text indexed is its last publication. Never with `draft`.
   */
  unpublished: boolean;
};

export type IndexProgress = { pages: number; total: number };

/** The vault locked, access changed, or the caller gave up while indexing: nothing is kept. */
export class IndexAbandoned extends Error {
  constructor() {
    super('Indexing stopped');
    this.name = 'IndexAbandoned';
  }
}

/** A page as the index holds it, for what reads its properties (`PageIndex`). */
export type IndexedEntry = Readonly<Omit<SearchPage, 'folderIds' | 'path'>> & {
  readonly folderIds: readonly FolderId[];
  readonly path: readonly (string | null)[];
  readonly title: string;
  readonly properties: readonly Readonly<PropertyData>[];
};

/** Which pages of the index to list (`PageIndex.list`). */
export type PageScope = {
  spaceId: SpaceId;
  /**
   * Only the pages directly in this folder, or at the space's top for null.
   * With `nested`, those in the folders under it too. Left out, the whole
   * space.
   */
  folderId?: FolderId | null;
  nested?: boolean;
  /** Only the pages tagged so (`hasTag`): what `tag:` search finds. */
  tag?: string;
};

/**
 * A search index of the pages this person can open (`indexSpaces`), which
 * also lists what it holds of them, for whatever reads their properties:
 * query tables, a folder's table, a reference to another page's value,
 * **Add property**'s suggestions. Each page is as search holds it, in the
 * version this person sees, so a page they can't open is never listed.
 *
 * It doesn't change once built: as pages change, a newer index stands in
 * for it (`with`, `updateIndex`; `usePageIndex`, in the app). Pages are
 * listed by title, then ID, so in the same order from one index to the
 * next, and hits with the same score and title by space, then ID. The
 * first read groups and sorts them; after that `page` takes constant time,
 * and `list` and `keys` time linear in the space's pages, their folders'
 * depth when `nested`, and their properties when matching a `tag` or
 * giving keys. An index derived from one already read is read from it,
 * sorting only the pages that changed.
 */
export class PageIndex extends SearchIndex<SearchPage> {
  #read: Lookup | null = null;

  override addText(doc: SearchPage, page: IndexedText): void {
    super.addText(doc, page);
    this.#read = null;
  }

  /** The page `pageId` in `spaceId`, or undefined if this person can't open it. */
  page(spaceId: SpaceId, pageId: PageId): IndexedEntry | undefined {
    return this.#lookup().byPage.get(pageKey(spaceId, pageId))?.entry;
  }

  /** The pages in `scope`, by title, then ID. */
  list({ spaceId, folderId, nested = false, tag }: PageScope): IndexedEntry[] {
    return (this.#lookup().bySpace.get(spaceId) ?? []).filter(
      (entry) =>
        (folderId === undefined ||
          entry.parentId === folderId ||
          (nested && (folderId === null || entry.folderIds.includes(folderId)))) &&
        (tag === undefined || hasTag(entry.properties, tag)),
    );
  }

  /**
   * The keys the pages in `scope` use, each once, as first written, in the
   * order they first appear (`list`'s, then each block's). Keys are the
   * same when a reference would take one for the other (`foldPropertyName`).
   */
  keys(scope: PageScope): string[] {
    const keys = new Map<string, string>();
    for (const { properties } of this.list(scope)) {
      for (const { key } of properties) {
        const folded = foldPropertyName(key);
        if (!keys.has(folded)) keys.set(folded, key);
      }
    }
    return [...keys.values()];
  }

  /**
   * An index like this one, but holding `pages`, each in place of the page
   * with its space and page ID, and in each of `spaces` (every one for
   * `'all'`) no page `pages` leaves out. A page's content can be left out
   * if this index holds that version of it. A page as this index holds it
   * (the same version, in the same place) is kept as indexed: only the
   * text of pages that changed is read again (`SearchIndex`), and its
   * lookups are copied, in time linear in the pages it holds, then sorted
   * only where pages changed. If nothing did, this index is returned
   * itself. Neither index changes again.
   *
   * Pages a space in `spaces` no longer holds as they were are let go of
   * at once: the new index compacts, in time linear in all the postings,
   * though still without reading any text again. So nothing this person
   * may no longer open stays even in memory. Only a page given outside
   * `spaces` may, as the version it replaced, until the index next
   * compacts: for a change this person made, whose version before was theirs.
   */
  with(
    pages: Iterable<readonly [SearchPage, IndexedText?]>,
    { spaces = [] }: { spaces?: Iterable<SpaceId> | 'all' } = {},
  ): PageIndex {
    const { byPage, bySpace } = this.#lookup();
    const given = new Map<string, readonly [SearchPage, IndexedText?]>();
    for (const page of pages) given.set(pageKey(page[0].spaceId, page[0].pageId), page);
    const removed = new Map<string, Held>();
    const added: Held[] = [];
    for (const [key, [doc, content]] of given) {
      const held = byPage.get(key);
      if (held && sameDoc(held.entry, doc)) continue;
      if (held) removed.set(key, held);
      const text = content ?? (held?.entry.revisionId === doc.revisionId ? held.page : undefined);
      if (!text) throw new Error('A page’s content is needed for a version the index doesn’t hold');
      const page = { doc, title: text.title, text: text.text, properties: text.properties ?? [] };
      added.push({ page, entry: { ...doc, title: page.title, properties: page.properties } });
    }
    const relisted = spaces === 'all' ? [...bySpace.keys()] : spaces;
    let relisting = false;
    for (const spaceId of relisted) {
      for (const entry of bySpace.get(spaceId) ?? []) {
        const key = pageKey(entry.spaceId, entry.pageId);
        const held = byPage.get(key);
        if (!given.has(key) && held) removed.set(key, held);
      }
      relisting = true;
    }
    if (removed.size === 0 && added.length === 0) return this;
    const next = this.derive(
      [...removed.values()].map(({ page }) => page),
      added.map(({ page }) => page),
      { compact: relisting && removed.size > 0 },
    );
    next.#read = followed({ byPage, bySpace }, removed, added);
    return next;
  }

  protected override order(a: SearchPage, b: SearchPage): number {
    return compare(a.spaceId, b.spaceId) || compare(a.pageId, b.pageId);
  }

  #lookup(): Lookup {
    if (this.#read === null) {
      const read: Lookup = { bySpace: new Map(), byPage: new Map() };
      for (const page of this.pages()) {
        const { doc, title, properties } = page;
        const entry: IndexedEntry = { ...doc, title, properties };
        let space = read.bySpace.get(doc.spaceId);
        if (!space) read.bySpace.set(doc.spaceId, (space = []));
        space.push(entry);
        read.byPage.set(pageKey(doc.spaceId, doc.pageId), { entry, page });
      }
      for (const space of read.bySpace.values()) space.sort(byTitle);
      this.#read = read;
    }
    return this.#read;
  }
}

/** A page an index holds: as it lists it, and as it indexed it. */
type Held = { entry: IndexedEntry; page: Readonly<IndexedPage<SearchPage>> };

/** What a `PageIndex` holds, grouped to read: each space's pages by title, and each page. */
type Lookup = { bySpace: Map<SpaceId, IndexedEntry[]>; byPage: Map<string, Held> };

const pageKey = (spaceId: SpaceId, pageId: PageId) => `${spaceId}/${pageId}`;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const byTitle = (a: IndexedEntry, b: IndexedEntry) =>
  a.title.localeCompare(b.title) || compare(a.pageId, b.pageId);

/** Whether a page is where `held` is, as the same version, and labelled the same. */
function sameDoc(held: IndexedEntry, doc: SearchPage): boolean {
  const same = (a: readonly unknown[], b: readonly unknown[]) =>
    a.length === b.length && a.every((value, i) => value === b[i]);
  return (
    held.revisionId === doc.revisionId &&
    held.parentId === doc.parentId &&
    held.draft === doc.draft &&
    held.unpublished === doc.unpublished &&
    same(held.folderIds, doc.folderIds) &&
    same(held.path, doc.path)
  );
}

/**
 * `read` without the pages `removed` and with `added`: only the spaces
 * they're in are sorted again, and a few pages are put in their place
 * rather than sorting the space again.
 */
function followed(
  read: Lookup,
  removed: ReadonlyMap<string, Held>,
  added: readonly Held[],
): Lookup {
  const byPage = new Map(read.byPage);
  const bySpace = new Map(read.bySpace);
  const changed = new Set<SpaceId>();
  for (const [key, held] of removed) {
    byPage.delete(key);
    changed.add(held.entry.spaceId);
  }
  for (const held of added) {
    byPage.set(pageKey(held.entry.spaceId, held.entry.pageId), held);
    changed.add(held.entry.spaceId);
  }
  const gone = new Set([...removed.values()].map(({ entry }) => entry));
  for (const spaceId of changed) {
    const entries = (bySpace.get(spaceId) ?? []).filter((entry) => !gone.has(entry));
    const more = added.filter(({ entry }) => entry.spaceId === spaceId).map(({ entry }) => entry);
    if (more.length > 8) {
      entries.push(...more);
      entries.sort(byTitle);
    } else {
      for (const entry of more) entries.splice(sortedAt(entries, entry), 0, entry);
    }
    if (entries.length > 0) bySpace.set(spaceId, entries);
    else bySpace.delete(spaceId);
  }
  return { byPage, bySpace };
}

/** Where `entry` goes in `entries`, sorted `byTitle`. */
function sortedAt(entries: readonly IndexedEntry[], entry: IndexedEntry): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (byTitle(entries[mid] as IndexedEntry, entry) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Pages opened at a time, so progress moves while a large space is indexed. */
const CHUNK = 100;

export const nameOf = (loaded: LoadedMetadata | null) =>
  loaded?.opened.kind === 'current' ? loaded.opened.metadata.name : null;

/**
 * A search index of every page this person (or agent) can read, each from
 * the version they see (`shownVersions`): readers the publication, editors
 * the draft, labelled `draft` when readers see something else, or a copy's
 * last publication, labelled `unpublished` as readers see none. Built from a
 * fresh listing of each space each time, so a page whose access was lost is
 * not in it. `spaceIds` limits it to those spaces; otherwise it covers each
 * space listed as held or shared with this person, skipping one that is
 * gone by the time it is loaded or fails its checks.
 *
 * A page whose shown version is in `kept`, as an earlier index read it
 * (`keptPages`), is indexed from there without being opened; a version's
 * content never changes. Others come from the revision cache where they can.
 * If the cache is cleared (the vault locks, or access changes) or `signal`
 * aborts, it stops with `IndexAbandoned` and what it built is dropped.
 */
export async function indexSpaces(
  ctx: ClientContext,
  {
    spaceIds,
    kept,
    onProgress,
    signal,
  }: {
    spaceIds?: readonly SpaceId[];
    kept?: KeptPages | null;
    onProgress?: (progress: IndexProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<PageIndex> {
  const live = liveness(ctx, signal);
  const listed = spaceIds === undefined;
  const ids = spaceIds ?? (await readableSpaces(ctx));
  live();
  const index = new PageIndex();
  await readPages(ctx, await loadSpaces(ctx, ids, listed), {
    reuse: (spaceId, page, head) => {
      const found = kept?.get(head);
      return found?.spaceId === spaceId && found.pageId === page ? found : undefined;
    },
    live,
    onProgress,
    each: (doc, content) => content && index.addText(doc, content),
  });
  return index;
}

/** What changed since an index was built, for `updateIndex` to follow. */
export type IndexChanges = {
  /** The spaces whose trees may have changed, or every one. */
  spaces: 'all' | readonly SpaceId[];
  /** Drafts this person saved since, in the order saved. */
  saved?: readonly SavedVersion[];
};

/** A draft this person saved: the version written, and the one it was saved over (`basedOn`). */
export type SavedVersion = {
  spaceId: SpaceId;
  pageId: PageId;
  basedOn: RevisionId;
  revisionId: RevisionId;
  /** The title and Markdown written, as the server holds them. */
  title: string;
  markdown: string;
};

/**
 * `index`, following `changes`: each space they name is listed again, as
 * `indexSpaces` lists it, and what it holds now stands in for what `index`
 * held of it (`PageIndex.with`). A space gone, or failing its checks, is
 * dropped; with `'all'`, so is one no longer listed as held or shared.
 * Only the versions `index` doesn't hold are opened, and only the pages
 * that changed are indexed again, so if nothing did, `index` is returned
 * itself. Stops with `IndexAbandoned` as `indexSpaces` does.
 *
 * A draft this person saved, in a space not listed, is put in without
 * listing anything, where it was, as the draft its editor sees, if `index`
 * holds the page in the version it was saved over, or in the one saved
 * before it. Otherwise, as when the page is new to the index, someone
 * else's version came between, or access changed, its space is listed.
 * A save, given as it is written, needs nothing from the server.
 */
export async function updateIndex(
  ctx: ClientContext,
  index: PageIndex,
  changes: IndexChanges,
  {
    onProgress,
    signal,
  }: { onProgress?: (progress: IndexProgress) => void; signal?: AbortSignal } = {},
): Promise<PageIndex> {
  const live = liveness(ctx, signal);
  const all = changes.spaces === 'all';
  const listing = new Set<SpaceId>(changes.spaces === 'all' ? [] : changes.spaces);
  // Each saved page's version as saved in turn; one not saved over the
  // version before it has its space listed instead.
  const saves = new Map<string, SavedVersion>();
  for (const saved of all ? [] : (changes.saved ?? [])) {
    if (listing.has(saved.spaceId)) continue;
    const key = pageKey(saved.spaceId, saved.pageId);
    const before =
      saves.get(key)?.revisionId ?? index.page(saved.spaceId, saved.pageId)?.revisionId;
    if (before === saved.basedOn) saves.set(key, saved);
    else listing.add(saved.spaceId);
  }
  const ids = all ? await readableSpaces(ctx) : [...listing];
  live();
  const pages: [SearchPage, IndexedText?][] = [];
  if (ids.length > 0) {
    await readPages(ctx, await loadSpaces(ctx, ids, true), {
      reuse: (spaceId, page, head) =>
        index.page(spaceId, page)?.revisionId === head ? 'held' : undefined,
      live,
      onProgress,
      each: (doc, content) => pages.push(content ? [doc, content] : [doc]),
    });
  }
  for (const saved of saves.values()) {
    const held = index.page(saved.spaceId, saved.pageId);
    if (!held || listing.has(saved.spaceId)) continue;
    pages.push([
      {
        spaceId: held.spaceId,
        pageId: held.pageId,
        revisionId: saved.revisionId,
        parentId: held.parentId,
        folderIds: [...held.folderIds],
        path: [...held.path],
        // As `readPages` labels a draft saved since: one readers don't see.
        draft: true,
        unpublished: false,
      },
      { title: saved.title, ...indexedContent(saved.markdown) },
    ]);
  }
  live();
  return index.with(pages, { spaces: all ? 'all' : ids });
}

/**
 * Whether `after` lacks a version of a page `before` held: the page is
 * gone, or another version stands in for it, but for a draft this person
 * saved over (`saved`), which was theirs to open, where one of their saves
 * of the page stands in for it. Linear in `before`'s pages and `saved`.
 */
export function letGo(
  before: PageIndex,
  after: PageIndex,
  saved: readonly SavedVersion[] = [],
): boolean {
  // Each page's versions saved over, and saved.
  const mine = new Map<string, { over: Set<RevisionId>; made: Set<RevisionId> }>();
  for (const { spaceId, pageId, basedOn, revisionId } of saved) {
    const key = pageKey(spaceId, pageId);
    const page = mine.get(key) ?? { over: new Set(), made: new Set() };
    page.over.add(basedOn);
    page.made.add(revisionId);
    mine.set(key, page);
  }
  return before.pages().some(({ doc }) => {
    const now = after.page(doc.spaceId, doc.pageId);
    if (!now) return true;
    if (now.revisionId === doc.revisionId) return false;
    const own = mine.get(pageKey(doc.spaceId, doc.pageId));
    return !own?.over.has(doc.revisionId) || !own.made.has(now.revisionId);
  });
}

/** Throws `IndexAbandoned` once the revision cache is cleared, or `signal` aborts. */
function liveness(ctx: ClientContext, signal: AbortSignal | undefined) {
  const generation = ctx.revisions.generation;
  return () => {
    if (signal?.aborted || ctx.revisions.generation !== generation) throw new IndexAbandoned();
  };
}

/**
 * The trees of the spaces `ids`. With `skipGone`, one gone by the time it
 * is loaded, closed to this person, or failing its checks is left out.
 */
async function loadSpaces(ctx: ClientContext, ids: readonly SpaceId[], skipGone: boolean) {
  const spaces = await Promise.all(
    ids.map(async (spaceId) => {
      try {
        return { spaceId, ...(await loadStructure(ctx, spaceId)) };
      } catch (error) {
        if (skipGone && (error instanceof CryptoError || unreachable(error))) return null;
        throw error;
      }
    }),
  );
  return spaces.filter((space) => space !== null);
}

/**
 * Each page of `spaces` as search lists it (`each`), with what its version
 * gives the index: `reuse`'s, or nothing if `reuse` says the index being
 * updated holds it (`'held'`), else opened. A page whose version can't be
 * opened is left out. Progress goes by the pages read.
 */
async function readPages(
  ctx: ClientContext,
  spaces: Awaited<ReturnType<typeof loadSpaces>>,
  {
    reuse,
    live,
    onProgress,
    each,
  }: {
    reuse: (spaceId: SpaceId, pageId: PageId, head: RevisionId) => IndexedText | 'held' | undefined;
    live: () => void;
    onProgress: ((progress: IndexProgress) => void) | undefined;
    each: (doc: SearchPage, content: IndexedText | null) => void;
  },
): Promise<void> {
  live();
  const total = spaces.reduce((sum, space) => sum + space.pages.length, 0);
  let done = 0;
  onProgress?.({ pages: done, total });
  for (const { spaceId, space, folders, pages } of spaces) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const top = space ? [nameOf(space.metadata)] : [];
    for (let at = 0; at < pages.length; at += CHUNK) {
      const chunk = pages.slice(at, at + CHUNK);
      // Each page's version as reused; a copy unpublished where it is lists
      // no head, so it is always opened.
      const reused = new Map<PageId, { revisionId: RevisionId; content: IndexedText | null }>();
      for (const page of chunk) {
        const head = page.draftHead ?? page.publishedHead;
        const found = head === null ? undefined : reuse(spaceId, page.id, head);
        if (head !== null && found !== undefined) {
          reused.set(page.id, { revisionId: head, content: found === 'held' ? null : found });
        }
      }
      const unkept = chunk.filter((page) => !reused.has(page.id));
      const versions = unkept.length > 0 ? await shownVersions(ctx, spaceId, unkept) : null;
      live();
      for (const page of chunk) {
        const version = reused.get(page.id) ?? contentOf(versions?.get(page.id));
        if (!version) continue;
        const path: (string | null)[] = [];
        const folderIds: FolderId[] = [];
        const seen = new Set<string>();
        for (let id = page.parentId; id !== null && !seen.has(id);) {
          seen.add(id);
          const folder = byId.get(id);
          if (!folder) break;
          path.unshift(nameOf(folder.metadata));
          folderIds.unshift(id);
          id = folder.parentId;
        }
        each(
          {
            spaceId,
            pageId: page.id,
            revisionId: version.revisionId,
            parentId: page.parentId,
            folderIds,
            path: [...top, ...path],
            draft: page.draftHead !== null && (page.publishedHead === null || page.draftChanges),
            unpublished: page.draftHead === null && page.publishedHead === null,
          },
          version.content,
        );
      }
      done += chunk.length;
      onProgress?.({ pages: done, total });
    }
  }
}

/**
 * What an index read from each version it holds, by that version, so a
 * later index can take it without opening the version again (`indexSpaces`).
 */
export type KeptPages = ReadonlyMap<
  RevisionId,
  {
    spaceId: SpaceId;
    pageId: PageId;
    title: string;
    text: string;
    properties: readonly Readonly<PropertyData>[];
  }
>;

export const keptPages = (index: SearchIndex<SearchPage>): KeptPages =>
  new Map(
    index
      .pages()
      .map(({ doc, title, text, properties }) => [
        doc.revisionId,
        { spaceId: doc.spaceId, pageId: doc.pageId, title, text, properties },
      ]),
  );

const KeptScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const KeptProperty = z.object({
  key: z.string(),
  type: z.enum(['list', 'number', 'boolean', 'date', 'url', 'wikilink', 'text']),
  value: z.union([KeptScalar, z.array(z.union([KeptScalar, z.array(KeptScalar)]))]),
}) satisfies z.ZodType<PropertyData>;
const KeptJson = z.array(
  z.tuple([RevisionId, SpaceId, PageId, z.string(), z.string(), z.array(KeptProperty)]),
);

// The desktop app keeps the index between launches as these bytes (#3),
// sealed for this person (`sealOnDevice`), so the file can't be taken for
// another account or server's. They are bound to the app's `build` too:
// another build may reduce pages differently (`searchText`), so its file
// opens as nothing and every page is read again. So does one kept before
// properties were (its rows have a field fewer), whatever its build.
const KEPT_KEY = 'search-index-key/v1';
const keptAd = (ctx: ClientContext, build: string) =>
  canonical('search-index/v1', [ctx.installationId, ctx.identity.public.id, build]);

/** `kept`, sealed for this person on this server and build. */
export function sealKept(ctx: ClientContext, kept: KeptPages, build: string): Uint8Array {
  const json = [...kept].map(([id, page]) => [
    id,
    page.spaceId,
    page.pageId,
    page.title,
    page.text,
    page.properties,
  ]);
  return sealOnDevice(ctx.identity, KEPT_KEY, keptAd(ctx, build), utf8(JSON.stringify(json)));
}

/** What `sealKept` sealed, or null if it isn't this person's on this server and build, or is damaged. */
export function openKept(ctx: ClientContext, sealed: Uint8Array, build: string): KeptPages | null {
  const plaintext = openOnDevice(ctx.identity, KEPT_KEY, keptAd(ctx, build), sealed);
  if (!plaintext) return null;
  try {
    const json = KeptJson.parse(JSON.parse(decodeUtf8(plaintext, 'search index')));
    return new Map(
      json.map(([id, spaceId, pageId, title, text, properties]) => [
        id,
        { spaceId, pageId, title, text, properties },
      ]),
    );
  } catch {
    return null;
  }
}

/** What a version gives the index, when it opens. */
function contentOf(
  version: OpenedRevision | null | undefined,
): { revisionId: RevisionId; content: IndexedText } | null {
  if (version?.opened.kind !== 'current') return null;
  const { title, markdown } = version.opened.payload;
  return { revisionId: version.record.revisionId, content: { title, ...indexedContent(markdown) } };
}

/**
 * Every space this person holds or has something shared in, as the server
 * lists them. Its word is enough here: each tree and version is checked
 * against the space it is loaded for.
 */
export async function readableSpaces(ctx: ClientContext): Promise<SpaceId[]> {
  const [{ spaces }, { shares }] = await Promise.all([
    ctx.api.call(structureRoutes.listSpaces),
    ctx.api.call(sharingRoutes.sharedWithMe),
  ]);
  return [...new Set([...spaces.map((s) => s.id), ...shares.map((s) => s.share.spaceId)])];
}

// Listed, then gone or closed to this person before its tree was loaded.
export const unreachable = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404);
