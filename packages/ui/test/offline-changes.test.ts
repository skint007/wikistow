import { PageId, SpaceId, type ClientContext } from '@wikistow/client';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vite-plus/test';
import { followQueue, onSent } from '../src/data/offline-changes.ts';
import { searchIndexKey, treeQuery } from '../src/data/queries.ts';

const ctx = {} as ClientContext;
const spaceId = SpaceId.parse('home');
const pageId = PageId.parse('plan');

// What the app does as it hears of the queue, here or from another tab.
describe('following the queue', () => {
  it('tells the search index of a page’s change discarded, for its space (#453)', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(searchIndexKey, 'index');
    queryClient.setQueryData(treeQuery(ctx, spaceId).queryKey, { pages: [] } as never);
    followQueue(queryClient, ctx, { kind: 'changed', spaceId, id: pageId });
    // Changed alone, as for a save into an entry it made: the tree, not the index.
    expect(queryClient.getQueryState(treeQuery(ctx, spaceId).queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(searchIndexKey)?.isInvalidated).toBe(false);
    const sessions: unknown[] = [];
    const stop = onSent((sent) => sessions.push(sent));
    followQueue(queryClient, ctx, { kind: 'discarded', spaceId, pageId });
    stop();
    expect(queryClient.getQueryState(searchIndexKey)?.isInvalidated).toBe(true);
    // No version was sent: the draft sessions hear nothing.
    expect(sessions).toEqual([]);
  });
});
