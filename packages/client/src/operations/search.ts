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
import { hasTag, indexedContent, SearchIndex, type IndexedText } from '../search.ts';
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
 * for it (`usePageIndex`, in the app). Pages are listed in the order the
 * space's tree lists them. The first read groups them, in time linear in
 * the index; after that `page` takes constant time, and `list` and `keys`
 * time linear in the space's pages, their folders' depth when `nested`,
 * and their properties when matching a `tag` or giving keys.
 */
export class PageIndex extends SearchIndex<SearchPage> {
  #bySpace: Map<SpaceId, IndexedEntry[]> | null = null;
  #byPage: Map<string, IndexedEntry> | null = null;

  override addText(doc: SearchPage, page: IndexedText): void {
    super.addText(doc, page);
    this.#bySpace = this.#byPage = null;
  }

  /** The page `pageId` in `spaceId`, or undefined if this person can't open it. */
  page(spaceId: SpaceId, pageId: PageId): IndexedEntry | undefined {
    return this.#lookup().byPage.get(`${spaceId}/${pageId}`);
  }

  /** The pages in `scope`, in the order the space's tree lists them. */
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

  #lookup() {
    if (this.#bySpace === null || this.#byPage === null) {
      this.#bySpace = new Map();
      this.#byPage = new Map();
      for (const { doc, title, properties } of this.pages()) {
        const entry: IndexedEntry = { ...doc, title, properties };
        let space = this.#bySpace.get(doc.spaceId);
        if (!space) this.#bySpace.set(doc.spaceId, (space = []));
        space.push(entry);
        this.#byPage.set(`${doc.spaceId}/${doc.pageId}`, entry);
      }
    }
    return { bySpace: this.#bySpace, byPage: this.#byPage };
  }
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
  const generation = ctx.revisions.generation;
  const live = () => {
    if (signal?.aborted || ctx.revisions.generation !== generation) throw new IndexAbandoned();
  };
  const listed = spaceIds === undefined;
  const ids = spaceIds ?? (await readableSpaces(ctx));
  live();
  const spaces = (
    await Promise.all(
      ids.map(async (spaceId) => {
        try {
          return { spaceId, ...(await loadStructure(ctx, spaceId)) };
        } catch (error) {
          if (listed && (error instanceof CryptoError || unreachable(error))) return null;
          throw error;
        }
      }),
    )
  ).filter((space) => space !== null);
  live();
  const total = spaces.reduce((sum, space) => sum + space.pages.length, 0);
  let done = 0;
  onProgress?.({ pages: done, total });
  const index = new PageIndex();
  for (const { spaceId, space, folders, pages } of spaces) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const top = space ? [nameOf(space.metadata)] : [];
    for (let at = 0; at < pages.length; at += CHUNK) {
      const chunk = pages.slice(at, at + CHUNK);
      // Each page's version as kept; a copy unpublished where it is lists no
      // head, so it is always opened.
      const reused = new Map<PageId, IndexedContent>();
      for (const page of chunk) {
        const head = page.draftHead ?? page.publishedHead;
        const found = head === null ? undefined : kept?.get(head);
        if (head !== null && found?.spaceId === spaceId && found.pageId === page.id) {
          reused.set(page.id, {
            revisionId: head,
            title: found.title,
            text: found.text,
            properties: found.properties,
          });
        }
      }
      const unkept = chunk.filter((page) => !reused.has(page.id));
      const versions = unkept.length > 0 ? await shownVersions(ctx, spaceId, unkept) : null;
      live();
      for (const page of chunk) {
        const content = reused.get(page.id) ?? contentOf(versions?.get(page.id));
        if (!content) continue;
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
        index.addText(
          {
            spaceId,
            pageId: page.id,
            revisionId: content.revisionId,
            parentId: page.parentId,
            folderIds,
            path: [...top, ...path],
            draft: page.draftHead !== null && (page.publishedHead === null || page.draftChanges),
            unpublished: page.draftHead === null && page.publishedHead === null,
          },
          content,
        );
      }
      done += chunk.length;
      onProgress?.({ pages: done, total });
    }
  }
  return index;
}

type IndexedContent = {
  revisionId: RevisionId;
  title: string;
  text: string;
  properties: readonly Readonly<PropertyData>[];
};

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
function contentOf(version: OpenedRevision | null | undefined): IndexedContent | null {
  if (version?.opened.kind !== 'current') return null;
  const { title, markdown } = version.opened.payload;
  return { revisionId: version.record.revisionId, title, ...indexedContent(markdown) };
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
