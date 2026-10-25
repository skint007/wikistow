import type { ClientContext } from '@wikistow/client';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vite-plus/test';
import { searchIndexChanged, searchIndexQuery } from '../src/data/queries.ts';

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

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    await settled();
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

  it('rebuilds at once when nothing builds and something shows it', async () => {
    const { queryClient, queryKey, builds } = harness();
    const stop = new QueryObserver(queryClient, { queryKey }).subscribe(() => {});
    await settled();
    builds[0]?.finish();
    await settled();
    searchIndexChanged(queryClient);
    await settled();
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

  it('takes a build already running to hold changes it may hold', async () => {
    const { queryClient, queryKey, builds } = harness();
    const stop = new QueryObserver(queryClient, { queryKey }).subscribe(() => {});
    await settled();
    searchIndexChanged(queryClient, { following: false });
    builds[0]?.finish();
    await settled();
    expect(builds).toHaveLength(1);
    // With none running, it rebuilds as for any change.
    searchIndexChanged(queryClient, { following: false });
    await settled();
    expect(builds).toHaveLength(2);
    stop();
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
