// What each kind of change loads again, and what it tells the search index.
import { PageId, RevisionId, SpaceId, type ClientContext } from '@wikistow/client';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vite-plus/test';
import { PLAIN } from '../src/vault/store.ts';

vi.mock(import('../src/data/queries.ts'), async (actual) => ({
  ...(await actual()),
  searchIndexChanged: vi.fn(),
}));

const { contentChanged } = await import('../src/data/content-changed.ts');
const { searchIndexChanged } = await import('../src/data/queries.ts');

const home = SpaceId.parse('home');
const work = SpaceId.parse('work');
const soup = PageId.parse('soup');
const notes = PageId.parse('notes');
const ctx = {} as ClientContext;

/** A page entry in home's tree, as last loaded. */
const entry = {
  id: soup,
  title: 'Soup',
  draftHead: 'r1',
  draftChanges: false,
  region: { kind: 'share', spaceId: home, shareId: 'recipes' },
};

/** Each query on screen, counting the times it loads. */
function shown() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const loads: string[] = [];
  const show = (kind: string, id: string, data: unknown = null) =>
    new QueryObserver(queryClient, {
      queryKey: [PLAIN, kind, id],
      queryFn: () => {
        loads.push(`${kind} ${id}`);
        return data;
      },
      staleTime: Infinity,
    }).subscribe(() => {});
  show('tree', home, { pages: [entry] });
  show('tree', work);
  for (const id of [soup, notes]) {
    show('page', id);
    show('history', id);
  }
  const first = vi.waitFor(() => {
    expect(loads).toHaveLength(6);
    expect(queryClient.isFetching()).toBe(0);
  });
  return {
    queryClient,
    /** What `run` loaded again. */
    loadsOf: async (run: () => Promise<void>) => {
      await first;
      loads.length = 0;
      await run();
      return [...loads].sort();
    },
  };
}

describe('contentChanged', () => {
  it('loads the spaces’ trees and the pages named, and tells the index those spaces', async () => {
    const { queryClient, loadsOf } = shown();
    vi.mocked(searchIndexChanged).mockClear();
    const loads = await loadsOf(() =>
      contentChanged(queryClient, ctx, [{ spaceId: home }, { spaceId: work, pageId: notes }]),
    );
    expect(loads).toEqual(['history notes', 'page notes', `tree ${home}`, `tree ${work}`]);
    expect(vi.mocked(searchIndexChanged).mock.calls).toEqual([
      [queryClient, { spaces: [home, work] }],
    ]);
  });

  it('shows a saved draft in its tree at once, and loads the tree again only when its marker changes', async () => {
    const { queryClient, loadsOf } = shown();
    const saved = (basedOn: string, revisionId: string) => ({
      spaceId: home,
      pageId: soup,
      basedOn: RevisionId.parse(basedOn),
      revisionId: RevisionId.parse(revisionId),
      payload: {
        format: { major: 1 as const, minor: 0 },
        title: 'Bean soup',
        markdown: 'beans',
        attachments: [],
        extensions: {},
      },
      region: { kind: 'owner' as const },
    });
    vi.mocked(searchIndexChanged).mockClear();
    const first = saved('r1', 'r2');
    // The first save since publishing marks the page as changed: the tree loads again.
    expect(await loadsOf(() => contentChanged(queryClient, ctx, { saved: first }))).toEqual([
      'history soup',
      'page soup',
      `tree ${home}`,
    ]);
    // With the time it was saved, as this device tells it: the server's answer has none.
    expect(vi.mocked(searchIndexChanged).mock.calls).toEqual([
      [
        queryClient,
        { saved: { ...first, updated: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) } },
      ],
    ]);
    // The next is patched in alone, the tree as loaded holding its marker by now.
    queryClient.setQueryData([PLAIN, 'tree', home], { pages: [{ ...entry, draftChanges: true }] });
    const next = saved('r2', 'r3');
    expect(await loadsOf(() => contentChanged(queryClient, ctx, { saved: next }))).toEqual([
      'history soup',
      'page soup',
    ]);
    expect(queryClient.getQueryData([PLAIN, 'tree', home])).toEqual({
      pages: [
        {
          ...entry,
          title: 'Bean soup',
          emoji: null,
          icon: null,
          symbol: null,
          region: { kind: 'owner' },
          draftHead: 'r3',
          draftChanges: true,
        },
      ],
    });
  });
});
