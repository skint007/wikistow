// What the app's search index asks of the client for each change: which
// spaces are listed again, which saves go in as written, and how often the
// desktop app keeps it. The indexes are real; the server is a map.
import {
  FolderId,
  PageId,
  RevisionId,
  SpaceId,
  type ClientContext,
  type IndexedText,
  type searchOperations,
} from '@wikistow/client';
import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type SearchPage = searchOperations.SearchPage;
type Changes = searchOperations.IndexChanges;

const home = SpaceId.parse('home');
const work = SpaceId.parse('work');

const client = vi.hoisted(() => ({
  // Each page as the server lists it for this person, by space and page.
  server: new Map<string, { doc: unknown; content: unknown }>(),
  updates: [] as unknown[],
  failNext: false,
  // The next update waits until it is given up.
  slowNext: false,
  keepSearchIndex: vi.fn(),
}));

const pageKey = (doc: SearchPage) => `${doc.spaceId}/${doc.pageId}`;
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
      // As the client's: spaces named are listed from the server, and a
      // save in another is put in where the index holds its page.
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
        const pages: [SearchPage, IndexedText?][] = listed()
          .filter(({ doc }) => spaces.includes(doc.spaceId))
          .map(({ doc, content }) => [doc, content]);
        for (const saved of changes.saved ?? []) {
          const held = index.page(saved.spaceId, saved.pageId);
          if (!held || spaces.includes(saved.spaceId)) continue;
          pages.push([
            {
              ...held,
              folderIds: [...held.folderIds],
              path: [...held.path],
              revisionId: saved.revisionId,
              draft: true,
            },
            { title: saved.title, text: saved.markdown },
          ]);
        }
        return index.with(pages, { spaces: changes.spaces === 'all' ? 'all' : spaces });
      },
      sealKept: () => new Uint8Array([1]),
      openKept: () => null,
    },
  };
});

// The desktop app, with a trusted keyring and nothing kept yet.
vi.mock('../src/desktop', () => ({
  desktop: {
    secureStorage: async () => true,
    searchIndex: async () => null,
    keepSearchIndex: client.keepSearchIndex,
  },
}));

const { GATHER_MS, KEEP_AT_MOST_MS, KEEP_MS, searchIndexChanged, searchIndexQuery } =
  await import('../src/data/queries.ts');

vi.stubGlobal('__APP_VERSION__', 'test');

let revisions = 0;

/** A page on the server, as this person's editor sees it. */
function put(spaceId: SpaceId, id: string, text: string, revisionId = `r${++revisions}`) {
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
  client.server.set(pageKey(doc), { doc, content: { title: id, text } });
  return doc;
}

/** The changes each update was asked to follow: the spaces, then the saves' versions. */
const updates = () =>
  (client.updates as Changes[]).map(({ spaces, saved = [] }) =>
    saved.length > 0 ? [spaces, saved.map(({ revisionId }) => revisionId)] : spaces,
  );

// What sealing checks of a session: its cache, cleared at a lock or access change.
const ctxOf = (revisions = { generation: 0 }) => ({ revisions }) as unknown as ClientContext;

async function shown() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const revisions = { generation: 0 };
  const ctx = ctxOf(revisions);
  const options = searchIndexQuery(ctx, queryClient);
  const stop = new QueryObserver(queryClient, options).subscribe(() => {});
  await vi.advanceTimersByTimeAsync(1);
  const data = () => queryClient.getQueryData(options.queryKey);
  return { queryClient, stop, revisions, data, refetch: () => queryClient.refetchQueries(options) };
}

beforeEach(() => {
  vi.useFakeTimers();
  revisions = 0;
  client.server.clear();
  client.updates = [];
  client.failNext = false;
  client.slowNext = false;
  client.keepSearchIndex.mockReset().mockResolvedValue(undefined);
  put(home, 'soup', 'bean soup');
  put(home, 'bread', 'rye bread');
  put(work, 'notes', 'meeting notes');
});
afterEach(() => void vi.useRealTimers());

describe('the app’s search index', () => {
  it('lists again only the spaces a change names, and every one when none are', async () => {
    const { queryClient, stop } = await shown();
    searchIndexChanged(queryClient, { spaceIds: [home] });
    searchIndexChanged(queryClient, { spaceIds: [work, home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(updates()).toEqual([[home, work]]);
    // Back in view, or after the stream dropped: anything may have changed.
    searchIndexChanged(queryClient);
    searchIndexChanged(queryClient, { spaceIds: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(updates()).toEqual([[home, work], 'all']);
    stop();
  });

  it('updates once when shown again, with no second update after it', async () => {
    const { queryClient, stop, data } = await shown();
    const first = data();
    // A tab back in view after an hour: `useTreeChanges` tells the index,
    // and the focus doesn't update it by itself.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    searchIndexChanged(queryClient);
    await vi.advanceTimersByTimeAsync(GATHER_MS * 2);
    expect(updates()).toEqual(['all']);
    // Nothing changed meanwhile: the same index.
    expect(data()).toBe(first);
    stop();
  });

  it('does nothing when the changes it gathered were taken meanwhile', async () => {
    const { queryClient, stop, refetch } = await shown();
    searchIndexChanged(queryClient, { spaceIds: [home] });
    // An update starting before the changes' gathering ends, as a retry's.
    await refetch();
    await vi.advanceTimersByTimeAsync(GATHER_MS * 2);
    expect(updates()).toEqual([[home]]);
    stop();
  });

  it('follows changes an update failed on with the next, saves in order', async () => {
    const { queryClient, stop, data } = await shown();
    client.failNext = true;
    const soup = put(home, 'soup', 'own words', 'own-1');
    searchIndexChanged(queryClient, {
      saved: { ...soup, basedOn: RevisionId.parse('r1'), title: 'soup', markdown: 'own words' },
    });
    searchIndexChanged(queryClient, { spaceIds: [work] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    const later = put(home, 'soup', 'more words', 'own-2');
    searchIndexChanged(queryClient, {
      saved: { ...later, basedOn: soup.revisionId, title: 'soup', markdown: 'more words' },
    });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    // The second save waits as one with the first, over what it was saved over.
    expect(updates()).toEqual([
      [[work], ['own-1']],
      [[work], ['own-2']],
    ]);
    expect((client.updates as Changes[])[1]?.saved?.[0]?.basedOn).toBe('r1');
    const index = data() as searchOperations.PageIndex | undefined;
    expect(index?.page(home, PageId.parse('soup'))?.revisionId).toBe('own-2');
    stop();
  });

  it('keeps no draft’s text while nothing shows it, only its space', async () => {
    const { queryClient, stop } = await shown();
    stop();
    const doc = put(home, 'soup', 'unshown words', 'own-1');
    searchIndexChanged(queryClient, {
      saved: { ...doc, basedOn: RevisionId.parse('r1'), title: 'soup', markdown: 'unshown words' },
    });
    const again = new QueryObserver(queryClient, searchIndexQuery(ctxOf(), queryClient));
    const unsubscribe = again.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(updates()).toEqual([[home]]);
    unsubscribe();
  });

  it('keeps no draft’s text from an update given up as nothing shows it', async () => {
    const { queryClient, stop } = await shown();
    client.slowNext = true;
    const doc = put(home, 'soup', 'given up words', 'own-1');
    searchIndexChanged(queryClient, {
      saved: { ...doc, basedOn: RevisionId.parse('r1'), title: 'soup', markdown: 'given up words' },
    });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    // Navigated away while it updated: React Query gives it up.
    stop();
    await vi.advanceTimersByTimeAsync(1_000);
    const again = new QueryObserver(queryClient, searchIndexQuery(ctxOf(), queryClient));
    const unsubscribe = again.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(updates()).toEqual([[[], ['own-1']], [home]]);
    unsubscribe();
  });

  it('forgets what it hadn’t taken when the vault locks', async () => {
    const { queryClient, stop, data } = await shown();
    const index = data();
    const doc = put(home, 'soup', 'locked words', 'own-1');
    searchIndexChanged(queryClient, {
      saved: { ...doc, basedOn: RevisionId.parse('r1'), title: 'soup', markdown: 'locked words' },
    });
    // Locked before the update: the index and what it waited for go.
    stop();
    queryClient.removeQueries();
    // Unlocked, with an index as fresh as a first build's: only what
    // changes from then on is followed.
    const options = searchIndexQuery(ctxOf(), queryClient);
    queryClient.setQueryData(options.queryKey, index);
    const unsubscribe = new QueryObserver(queryClient, options).subscribe(() => {});
    searchIndexChanged(queryClient, { spaceIds: [work] });
    await vi.advanceTimersByTimeAsync(GATHER_MS * 2);
    expect(updates()).toEqual([[work]]);
    unsubscribe();
  });

  it('takes a burst of autosaves on a page that shows it without listing every space, and is kept once', async () => {
    const { queryClient, stop, data } = await shown();
    await vi.advanceTimersByTimeAsync(0);
    // The first build, kept at once.
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    let basedOn = RevisionId.parse('r1');
    const indexes = new Set<unknown>();
    for (let i = 1; i <= 6; i++) {
      // An autosave: the save lands, then about a second later the server
      // tells of a change in its space, the echo.
      const doc = put(home, 'soup', `bean soup ${i}`, `own-${i}`);
      searchIndexChanged(queryClient, {
        saved: { ...doc, basedOn, title: 'soup', markdown: `bean soup ${i}` },
      });
      basedOn = doc.revisionId;
      await vi.advanceTimersByTimeAsync(GATHER_MS);
      const patched = data();
      indexes.add(patched);
      await vi.advanceTimersByTimeAsync(1_000 - GATHER_MS);
      searchIndexChanged(queryClient, { spaceIds: [home] });
      await vi.advanceTimersByTimeAsync(GATHER_MS);
      // The echo finds the save already in: the same index.
      expect(data()).toBe(patched);
      await vi.advanceTimersByTimeAsync(700 - GATHER_MS);
    }
    expect(indexes.size).toBe(6);
    // Saves taken as written, echoes listing their space alone.
    expect(updates()).toEqual(
      Array.from({ length: 6 }, (_, i) => [[[], [`own-${i + 1}`]], [home]]).flat(),
    );
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KEEP_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(2);
    stop();
  });

  it('is kept at once when someone else’s change lets a version go, as from memory', async () => {
    const { queryClient, stop } = await shown();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    // A page added only adds: kept with the burst.
    put(work, 'plans', 'new plans');
    searchIndexChanged(queryClient, { spaceIds: [work] });
    await vi.advanceTimersByTimeAsync(GATHER_MS + 1);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    // Access lost to a page: it leaves the file with the update.
    client.server.delete(`${home}/bread`);
    searchIndexChanged(queryClient, { spaceIds: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS + 1);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(2);
    // Someone else's version standing in, as a new publication for a reader.
    put(work, 'notes', 'edited elsewhere');
    searchIndexChanged(queryClient, { spaceIds: [work] });
    await vi.advanceTimersByTimeAsync(GATHER_MS + 1);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(3);
    // Nothing waits to keep one before it later.
    await vi.advanceTimersByTimeAsync(KEEP_AT_MOST_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(3);
    stop();
  });

  it('is kept at least once a minute while saves keep coming', async () => {
    const { queryClient, stop } = await shown();
    await vi.advanceTimersByTimeAsync(0);
    let basedOn = RevisionId.parse('r1');
    for (let i = 1; i <= (KEEP_AT_MOST_MS * 2.5) / 1_000; i++) {
      const doc = put(home, 'soup', `words ${i}`, `own-${i}`);
      searchIndexChanged(queryClient, {
        saved: { ...doc, basedOn, title: 'soup', markdown: `words ${i}` },
      });
      basedOn = doc.revisionId;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // The first build, then once a minute.
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(3);
    stop();
  });

  it('isn’t kept once locked away', async () => {
    const { queryClient, stop } = await shown();
    await vi.advanceTimersByTimeAsync(0);
    put(work, 'plans', 'new plans');
    searchIndexChanged(queryClient, { spaceIds: [work] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    // Locked while the update waits to be kept.
    stop();
    queryClient.clear();
    await vi.advanceTimersByTimeAsync(KEEP_AT_MOST_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('isn’t kept by the session before an access change', async () => {
    const { queryClient, stop, revisions } = await shown();
    await vi.advanceTimersByTimeAsync(0);
    put(work, 'plans', 'new plans');
    searchIndexChanged(queryClient, { spaceIds: [work] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    // `refreshAccess` clears the cache; its fresh build is kept on its own.
    revisions.generation += 1;
    await vi.advanceTimersByTimeAsync(KEEP_AT_MOST_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    stop();
  });
});
