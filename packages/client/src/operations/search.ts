import { sharingRoutes, structureRoutes, type PageId, type SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { SearchIndex } from '../search.ts';
import { shownVersions } from './pages.ts';
import type { LoadedMetadata } from './records.ts';
import type { ClientContext } from './session.ts';
import { loadStructure } from './spaces.ts';

/** A page as search lists it. */
export type SearchPage = {
  spaceId: SpaceId;
  pageId: PageId;
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
 * Opened pages come from the revision cache where they can. If the cache is
 * cleared (the vault locks, or access changes) or `signal` aborts, it stops
 * with `IndexAbandoned` and what it built is dropped.
 */
export async function indexSpaces(
  ctx: ClientContext,
  {
    spaceIds,
    onProgress,
    signal,
  }: {
    spaceIds?: readonly SpaceId[];
    onProgress?: (progress: IndexProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<SearchIndex<SearchPage>> {
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
  const index = new SearchIndex<SearchPage>();
  for (const { spaceId, space, folders, pages } of spaces) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const top = space ? [nameOf(space.metadata)] : [];
    for (let at = 0; at < pages.length; at += CHUNK) {
      const chunk = pages.slice(at, at + CHUNK);
      const versions = await shownVersions(ctx, spaceId, chunk);
      live();
      for (const page of chunk) {
        const opened = versions.get(page.id)?.opened;
        if (opened?.kind !== 'current') continue;
        const path: (string | null)[] = [];
        const seen = new Set<string>();
        for (let id = page.parentId; id !== null && !seen.has(id);) {
          seen.add(id);
          const folder = byId.get(id);
          if (!folder) break;
          path.unshift(nameOf(folder.metadata));
          id = folder.parentId;
        }
        index.add(
          {
            spaceId,
            pageId: page.id,
            path: [...top, ...path],
            draft: page.draftHead !== null && (page.publishedHead === null || page.draftChanges),
            unpublished: page.draftHead === null && page.publishedHead === null,
          },
          opened.payload,
        );
      }
      done += chunk.length;
      onProgress?.({ pages: done, total });
    }
  }
  return index;
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
