import {
  FolderId,
  PageId,
  RevisionId,
  SpaceId,
  type ClientContext,
  type IndexedText,
  type searchOperations,
} from '@wikistow/client';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GATHER_MS, KEEP_AT_MOST_MS } from '../src/data/index-tracker.ts';

type SearchPage = searchOperations.SearchPage;
type Changes = searchOperations.IndexChanges;

const home = SpaceId.parse('home');
const work = SpaceId.parse('work');

// The index's own query function runs against these: each page as the
// server lists it, by space and page, and what each update was asked.
const client = vi.hoisted(() => ({
  server: new Map<string, { doc: unknown; content: unknown }>(),
  updates: [] as unknown[],
  failNext: false,
  // The next update waits until it is given up.
  slowNext: false,
  keepSearchIndex: vi.fn(),
}));
const listed = () => [...client.server.values()] as { doc: SearchPage; content: IndexedText }[];

vi.mock('@wikistow/client', async (actual) => {
  const real = await actual<typeof import('@wikistow/client')>();
  const ops = real.searchOperations;
  return {
    ...real,
    searchOperations: {
      ...ops,
      indexSpaces: async () => {
        const index = new ops.PageIndex();
        for (const { doc, content } of listed()) index.addText(doc, content);
        return index;
      },
      // As the client's, for the spaces named; saves aren't put in.
      updateIndex: async (
        _ctx: unknown,
        index: searchOperations.PageIndex,
        changes: Changes,
        { signal }: { signal?: AbortSignal } = {},
      ) => {
        client.updates.push(changes);
        if (client.slowNext) {
          client.slowNext = false;
          await new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(new ops.IndexAbandoned())),
          );
        }
        if (client.failNext) {
          client.failNext = false;
          throw new Error('offline');
        }
        const spaces = changes.spaces === 'all' ? [home, work] : changes.spaces;
        const pages: [SearchPage, IndexedText][] = listed()
          .filter(({ doc }) => spaces.includes(doc.spaceId))
          .map(({ doc, content }) => [doc, content]);
        return index.with(pages, { spaces: changes.spaces === 'all' ? 'all' : spaces });
      },
      sealKept: () => new Uint8Array([1]),
      openKept: () => null,
    },
  };
});

// A device that keeps the index, as the desktop app with a trusted keyring
// does with Every page, with nothing kept yet.
vi.mock('../src/data/index-file', () => ({
  searchIndexFile: async () => ({ read: async () => null, write: client.keepSearchIndex }),
}));

const { searchIndexChanged, searchIndexQuery } = await import('../src/data/queries.ts');

vi.stubGlobal('__APP_VERSION__', 'test');

// The index's key, with builds this test finishes by hand: each resolves
// when `finish` is called, and `aborted` says whether React Query gave up on it.
function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Untyped, so the builds can give numbers.
  const queryKey: QueryKey = searchIndexQuery({} as ClientContext, queryClient).queryKey;
  const builds: { finish: () => void; aborted: () => boolean }[] = [];
  const queryFn = ({ signal }: { signal: AbortSignal }) =>
    new Promise<number>((resolve) => {
      const build = builds.length + 1;
      builds.push({ finish: () => resolve(build), aborted: () => signal.aborted });
    });
  queryClient.setQueryDefaults(queryKey, { queryFn: queryFn as never, staleTime: 60_000 });
  return { queryClient, queryKey, builds };
}

// Timers are the test's: changes gather for `GATHER_MS` while the index is shown.
const settled = () => vi.advanceTimersByTimeAsync(0);
const gathered = () => vi.advanceTimersByTimeAsync(GATHER_MS);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

// How the index's changes reach its query (`trackerOf`): the timing is
// `index-tracker.test.ts`'s; this is what React Query does with them.
describe('a change to the search index', () => {
  it('follows a build already running with another, without cancelling it', async () => {
    const { queryClient, queryKey, builds } = harness();
    const stop = new QueryObserver(queryClient, { queryKey }).subscribe(() => {});
    await settled();
    expect(builds).toHaveLength(1);
    // Saves while it builds share one more build, which starts once it's done.
    searchIndexChanged(queryClient);
    searchIndexChanged(queryClient);
    searchIndexChanged(queryClient);
    await gathered();
    expect(builds).toHaveLength(1);
    builds[0]?.finish();
    await settled();
    expect(builds[0]?.aborted()).toBe(false);
    expect(builds).toHaveLength(2);
    builds[1]?.finish();
    await settled();
    expect(queryClient.getQueryData(queryKey)).toBe(2);
    expect(builds).toHaveLength(2);
    stop();
  });

  it('leaves it stale, for when it is next shown, when a build running is shown by nothing', async () => {
    const { queryClient, queryKey, builds } = harness();
    // As a component with `enabled: false` leaves a build it started.
    const fetching = queryClient.fetchQuery({ queryKey });
    await settled();
    searchIndexChanged(queryClient);
    builds[0]?.finish();
    await fetching;
    await settled();
    expect(builds).toHaveLength(1);
    expect(queryClient.getQueryCache().find({ queryKey })?.isStale()).toBe(true);
  });

  it('only marks it stale when nothing builds or shows it', async () => {
    const { queryClient, queryKey, builds } = harness();
    queryClient.setQueryData(queryKey, 0);
    searchIndexChanged(queryClient);
    await settled();
    expect(builds).toHaveLength(0);
    expect(queryClient.getQueryCache().find({ queryKey })?.isStale()).toBe(true);
  });
});

/** A page on the server. */
function put(spaceId: SpaceId, id: string, revisionId: string) {
  const doc: SearchPage = {
    spaceId,
    pageId: PageId.parse(id),
    revisionId: RevisionId.parse(revisionId),
    parentId: FolderId.parse('recipes'),
    folderIds: [FolderId.parse('recipes')],
    path: ['Home', 'Recipes'],
    draft: true,
    unpublished: false,
  };
  client.server.set(`${spaceId}/${id}`, { doc, content: { title: id, text: id } });
  return doc;
}

/** The index's own query, shown, for a session whose cache is at `revisions.generation`. */
async function shownIndex() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const revisions = { generation: 0 };
  // What sealing checks of a session: its cache, cleared at a lock or access change.
  const ctx = { revisions } as unknown as ClientContext;
  const options = searchIndexQuery(ctx, queryClient);
  const stop = new QueryObserver(queryClient, options).subscribe(() => {});
  await settled();
  return { queryClient, options, stop, revisions };
}

// How the index's query function uses what changed: what it puts back,
// what it forgets, and when it is kept.
describe('the index’s query', () => {
  beforeEach(() => {
    client.server.clear();
    client.updates = [];
    client.failNext = false;
    client.slowNext = false;
    client.keepSearchIndex.mockReset().mockResolvedValue(undefined);
    put(home, 'soup', 'r1');
    put(work, 'notes', 'r2');
  });

  it('puts back what a failed update took, and forgets it all when the vault locks', async () => {
    const { queryClient, options, stop } = await shownIndex();
    client.failNext = true;
    searchIndexChanged(queryClient, { spaces: [work] });
    await gathered();
    searchIndexChanged(queryClient, { spaces: [home] });
    await gathered();
    // Locked with a change noted: it goes with the index.
    searchIndexChanged(queryClient, { spaces: [work] });
    const index = queryClient.getQueryData(options.queryKey);
    stop();
    queryClient.removeQueries();
    queryClient.setQueryData(options.queryKey, index);
    const again = new QueryObserver(queryClient, options).subscribe(() => {});
    searchIndexChanged(queryClient, { spaces: [home] });
    await gathered();
    expect(client.updates.map((changes) => (changes as Changes).spaces)).toEqual([
      [work],
      [work, home],
      [home],
    ]);
    again();
  });

  it('keeps no draft’s text from an update given up as nothing shows it, only its space', async () => {
    const { queryClient, options, stop } = await shownIndex();
    client.slowNext = true;
    searchIndexChanged(queryClient, {
      saved: {
        ...put(home, 'soup', 'own-1'),
        basedOn: RevisionId.parse('r1'),
        payload: { title: 'soup', markdown: 'given up words', extensions: {} },
      },
    });
    await gathered();
    // Navigated away while it updated: React Query gives it up.
    stop();
    await settled();
    const again = new QueryObserver(queryClient, options).subscribe(() => {});
    await gathered();
    expect(
      client.updates.map((changes) => {
        const { spaces, saved = [] } = changes as Changes;
        return [spaces, saved.map(({ revisionId }) => revisionId)];
      }),
    ).toEqual([
      [[], ['own-1']],
      [[home], []],
    ]);
    again();
  });

  it('is kept at once when an update lets a version go, but not by a session since cleared', async () => {
    const { queryClient, stop, revisions } = await shownIndex();
    // The first build, kept at once.
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    // Access lost to a page: it leaves the file with the update.
    client.server.delete(`${home}/soup`);
    searchIndexChanged(queryClient, { spaces: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS + 1);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(2);
    // A page added only adds, and waits to be kept with others; `refreshAccess`
    // clears the session's cache meanwhile, and its fresh build is kept on its own.
    put(work, 'plans', 'r3');
    searchIndexChanged(queryClient, { spaces: [work] });
    await gathered();
    revisions.generation += 1;
    await vi.advanceTimersByTimeAsync(KEEP_AT_MOST_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(2);
    stop();
  });
});
