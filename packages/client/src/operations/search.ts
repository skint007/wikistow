import { PageId, RevisionId, sharingRoutes, SpaceId, structureRoutes } from '@wikistow/contracts';
import { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { openOnDevice, sealOnDevice } from '../device-seal.ts';
import { canonical, decodeUtf8, utf8 } from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import { SearchIndex, searchText } from '../search.ts';
import { shownVersions } from './pages.ts';
import type { LoadedMetadata, OpenedRevision } from './records.ts';
import type { ClientContext } from './session.ts';
import { loadStructure } from './spaces.ts';

/** A page as search lists it. */
export type SearchPage = {
  spaceId: SpaceId;
  pageId: PageId;
  /** The version whose title and text are indexed. */
  revisionId: RevisionId;
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
      // Each page's version as kept; a copy unpublished where it is lists no
      // head, so it is always opened.
      const reused = new Map<PageId, IndexedContent>();
      for (const page of chunk) {
        const head = page.draftHead ?? page.publishedHead;
        const found = head === null ? undefined : kept?.get(head);
        if (head !== null && found?.spaceId === spaceId && found.pageId === page.id) {
          reused.set(page.id, { revisionId: head, title: found.title, text: found.text });
        }
      }
      const unkept = chunk.filter((page) => !reused.has(page.id));
      const versions = unkept.length > 0 ? await shownVersions(ctx, spaceId, unkept) : null;
      live();
      for (const page of chunk) {
        const content = reused.get(page.id) ?? contentOf(versions?.get(page.id));
        if (!content) continue;
        const path: (string | null)[] = [];
        const seen = new Set<string>();
        for (let id = page.parentId; id !== null && !seen.has(id);) {
          seen.add(id);
          const folder = byId.get(id);
          if (!folder) break;
          path.unshift(nameOf(folder.metadata));
          id = folder.parentId;
        }
        index.addText(
          {
            spaceId,
            pageId: page.id,
            revisionId: content.revisionId,
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

type IndexedContent = { revisionId: RevisionId; title: string; text: string };

/**
 * What an index read from each version it holds, by that version, so a
 * later index can take it without opening the version again (`indexSpaces`).
 */
export type KeptPages = ReadonlyMap<
  RevisionId,
  { spaceId: SpaceId; pageId: PageId; title: string; text: string }
>;

export const keptPages = (index: SearchIndex<SearchPage>): KeptPages =>
  new Map(
    index
      .pages()
      .map(({ doc, title, text }) => [
        doc.revisionId,
        { spaceId: doc.spaceId, pageId: doc.pageId, title, text },
      ]),
  );

const KeptJson = z.array(z.tuple([RevisionId, SpaceId, PageId, z.string(), z.string()]));

// The desktop app keeps the index between launches as these bytes (#3),
// sealed for this person (`sealOnDevice`), so the file can't be taken for
// another account or server's. They are bound to the app's `build` too:
// another build may reduce pages differently (`searchText`), so its file
// opens as nothing and every page is read again.
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
      json.map(([id, spaceId, pageId, title, text]) => [id, { spaceId, pageId, title, text }]),
    );
  } catch {
    return null;
  }
}

/** What a version gives the index, when it opens. */
function contentOf(version: OpenedRevision | null | undefined): IndexedContent | null {
  if (version?.opened.kind !== 'current') return null;
  const { title, markdown } = version.opened.payload;
  return { revisionId: version.record.revisionId, title, text: searchText(markdown) };
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
