// What the app's search index asks of the client for each change: which
// spaces are listed again, and how often the desktop app keeps it.
import { SpaceId, type ClientContext, type searchOperations } from '@wikistow/client';
import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const client = vi.hoisted(() => ({
  indexSpaces: vi.fn(),
  updateIndex: vi.fn(),
  keepSearchIndex: vi.fn(),
  narrowed: vi.fn(),
  index: 0,
}));

vi.mock('@wikistow/client', async (actual) => {
  const real = await actual<typeof import('@wikistow/client')>();
  return {
    ...real,
    searchOperations: {
      ...real.searchOperations,
      indexSpaces: client.indexSpaces,
      updateIndex: client.updateIndex,
      narrowed: client.narrowed,
      keptPages: () => new Map(),
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

const home = SpaceId.parse('home');
const work = SpaceId.parse('work');

/**
 * An index as the client gives one, only told apart by which it is. Not a
 * plain object, as `PageIndex` isn't, so React Query keeps it as given.
 */
class Built {
  readonly which = ++client.index;
}
const anIndex = () => new Built() as unknown as searchOperations.PageIndex;

/** The changes each update was asked to follow. */
const updates = () =>
  client.updateIndex.mock.calls.map(
    ([, , changes]) => (changes as searchOperations.IndexChanges).spaces,
  );

async function shown() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // What sealing checks of a session: its cache, cleared at a lock or access change.
  const revisions = { generation: 0 };
  const ctx = { revisions } as unknown as ClientContext;
  const options = searchIndexQuery(ctx, queryClient);
  const stop = new QueryObserver(queryClient, options).subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  return { queryClient, stop, revisions, data: () => queryClient.getQueryData(options.queryKey) };
}

beforeEach(() => {
  vi.useFakeTimers();
  client.index = 0;
  client.indexSpaces.mockReset().mockImplementation(async () => anIndex());
  client.updateIndex.mockReset().mockImplementation(async () => anIndex());
  client.keepSearchIndex.mockReset().mockResolvedValue(undefined);
  // Updates that lose nothing, as a save's, unless a test says otherwise.
  client.narrowed.mockReset().mockReturnValue(false);
});
afterEach(() => void vi.useRealTimers());

describe('the app’s search index', () => {
  it('lists again only the spaces a change names, and every one when none are', async () => {
    const { queryClient, stop } = await shown();
    expect(client.indexSpaces).toHaveBeenCalledTimes(1);
    searchIndexChanged(queryClient, { spaceIds: [home] });
    searchIndexChanged(queryClient, { spaceIds: [work, home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(updates()).toEqual([[home, work]]);
    // Back in view, or after the stream dropped: anything may have changed.
    searchIndexChanged(queryClient);
    searchIndexChanged(queryClient, { spaceIds: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(updates()).toEqual([[home, work], 'all']);
    expect(client.indexSpaces).toHaveBeenCalledTimes(1);
    stop();
  });

  it('builds once when shown again, with no second build after it', async () => {
    const { queryClient, stop, data } = await shown();
    const first = data();
    // A tab back in view after an hour: `useTreeChanges` tells the index,
    // and the focus doesn't build it again by itself.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    searchIndexChanged(queryClient);
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(updates()).toEqual(['all']);
    expect(client.updateIndex.mock.calls[0]?.[1]).toBe(first);
    stop();
  });

  it('follows changes an update failed on with the next', async () => {
    const { queryClient, stop } = await shown();
    client.updateIndex.mockRejectedValueOnce(new Error('offline'));
    searchIndexChanged(queryClient, { spaceIds: [work] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    searchIndexChanged(queryClient, { spaceIds: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(updates()).toEqual([[work], [work, home]]);
    stop();
  });

  it('is kept on the desktop once a burst of changes ends, not after each', async () => {
    const { queryClient, stop, data } = await shown();
    // The first build, kept at once.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) {
      searchIndexChanged(queryClient, { spaceIds: [home] });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(client.updateIndex).toHaveBeenCalledTimes(6);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KEEP_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(2);
    // An update that changed nothing gives the same index, and isn't kept again.
    client.updateIndex.mockImplementation(async (_ctx, index) => index);
    searchIndexChanged(queryClient, { spaceIds: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS + KEEP_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(2);
    expect(data()).toBeDefined();
    stop();
  });

  it('is kept at least once a minute while changes keep coming', async () => {
    const { queryClient, stop } = await shown();
    await vi.advanceTimersByTimeAsync(0);
    for (let at = 0; at < KEEP_AT_MOST_MS * 2.5; at += 1_000) {
      searchIndexChanged(queryClient, { spaceIds: [home] });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // The first build, then once a minute.
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(3);
    stop();
  });

  it('is kept at once when an update holds less than before, as from memory', async () => {
    const { queryClient, stop } = await shown();
    await vi.advanceTimersByTimeAsync(0);
    searchIndexChanged(queryClient, { spaceIds: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    // Access lost, say: the page leaves the file with the next update.
    client.narrowed.mockReturnValue(true);
    searchIndexChanged(queryClient, { spaceIds: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS + 1);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(2);
    // Nothing waits to keep the one before it later.
    await vi.advanceTimersByTimeAsync(KEEP_AT_MOST_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(2);
    stop();
  });

  it('isn’t kept once locked away', async () => {
    const { queryClient, stop } = await shown();
    await vi.advanceTimersByTimeAsync(0);
    searchIndexChanged(queryClient, { spaceIds: [home] });
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
    searchIndexChanged(queryClient, { spaceIds: [home] });
    await vi.advanceTimersByTimeAsync(GATHER_MS);
    // `refreshAccess` clears the cache; its fresh build is kept on its own.
    revisions.generation += 1;
    await vi.advanceTimersByTimeAsync(KEEP_AT_MOST_MS);
    expect(client.keepSearchIndex).toHaveBeenCalledTimes(1);
    stop();
  });
});
