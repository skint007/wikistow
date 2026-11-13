import { describe, expect, it } from 'vite-plus/test';
import { FolderId, PageId, queueOperations, SpaceId } from '../src/index.ts';

// A space's tree, with what the queue shows of a folder's order changed offline (#400).
type Tree = Parameters<typeof queueOperations.withQueued>[0];

const spaceId = SpaceId.parse('space');
const folder = FolderId.parse('folder');
const page = (id: string, position: string | null) => ({
  id: PageId.parse(id),
  parentId: folder,
  permissionVersion: 1,
  draftHead: null,
  publishedHead: null,
  draftChanges: false,
  position,
  title: id,
  emoji: null,
  icon: null,
  symbol: null,
  region: null,
});
const tree = {
  space: null,
  shares: [],
  folders: [{ id: folder, parentId: null, permissionVersion: 1, position: null, metadata: null }],
  pages: [page('a', 'a0'), page('b', 'a1')],
  agentActivity: null,
} as unknown as Tree;

const order = (positions: Record<string, string | null>, at: number) =>
  ({
    kind: 'order',
    id: folder,
    spaceId,
    parentId: folder,
    name: 'Folder',
    positions,
    failure: null,
    at,
  }) as queueOperations.QueueEntry;

const move = (position: string, at: number) =>
  ({
    kind: 'move',
    id: PageId.parse('a'),
    node: 'page',
    spaceId,
    name: 'a',
    parentId: folder,
    position,
    failure: null,
    at,
  }) as queueOperations.QueueEntry;

const positionOf = (shown: Tree, id: string) => shown.pages.find((p) => p.id === id)?.position;

describe('withQueued and a folder’s order', () => {
  it('shows the positions an order waiting there gives', () => {
    const shown = queueOperations.withQueued(tree, spaceId, [order({ a: 'a2' }, 1)]);
    expect(positionOf(shown, 'a')).toBe('a2');
    expect(positionOf(shown, 'b')).toBe('a1');
  });

  it('shows where a later drop put it, over an earlier order', () => {
    const shown = queueOperations.withQueued(tree, spaceId, [order({ a: 'a2' }, 1), move('a3', 2)]);
    expect(positionOf(shown, 'a')).toBe('a3');
  });

  it('shows a later order over an earlier drop', () => {
    const shown = queueOperations.withQueued(tree, spaceId, [move('a3', 1), order({ a: 'a2' }, 2)]);
    expect(positionOf(shown, 'a')).toBe('a2');
  });

  it('puts a move in at the end as the order waiting there has it', () => {
    const elsewhere = {
      ...tree,
      folders: [...tree.folders, { ...tree.folders[0]!, id: FolderId.parse('other') }],
      pages: [...tree.pages, { ...page('x', null), parentId: FolderId.parse('other') }],
    } as unknown as Tree;
    const inbound = {
      kind: 'move',
      id: PageId.parse('x'),
      node: 'page',
      spaceId,
      name: 'x',
      parentId: folder,
      failure: null,
      at: 2,
    } as queueOperations.QueueEntry;
    const shown = queueOperations.withQueued(elsewhere, spaceId, [order({ a: 'a5' }, 1), inbound]);
    expect(positionOf(shown, 'x')! > 'a5').toBe(true);
  });
});
