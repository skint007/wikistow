import {
  childrenInOrder,
  orderOperations,
  shownTitle,
  type ClientContext,
  type FolderId,
  type PageId,
  type PositionWrite,
  type SpaceId,
  type spaceOperations,
} from '@wikistow/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Name } from '@/components/name';
import { contentChanged } from '../data/content-changed';
import { pageWriter } from '../data/offline-changes';
import { errorMessage } from '../errors';
import { showNotice } from '../page/undo-notice';
import { useClient } from '../vault/store';
import { useAvailability, type Waiting } from './availability';

// A folder's own order in the sidebar (#400): reordering by drag, Move up
// and Move down, and Sort by name. The order is the folder's, shared by
// everyone who sees it (protocol section 10, Order). Online, positions go to the
// server at once; offline, or while one of them has a change waiting, each
// waits on this device as a move to where it is already (ADR 0009).

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;

/** What a folder and a page are listed by where names decide the order, as the sidebar shows them. */
export const treeLabels = {
  folder: (folder: Tree['folders'][number]) =>
    folder.metadata?.opened.kind === 'current'
      ? folder.metadata.opened.metadata.name
      : 'Unreadable folder',
  page: (page: Tree['pages'][number]) => shownTitle(page.title),
};

/** The folders and pages in `parentId`, or at the top, in the order the sidebar lists them. */
export const childrenOf = (tree: Tree, parentId: FolderId | null) =>
  childrenInOrder(tree, parentId, treeLabels);

type Waits = { waiting: (id: PageId | FolderId | null) => Waiting };

// The children whose order this app writes: not one made offline, which
// the server places as it is made.
const ordered = (tree: Tree, parentId: FolderId | null, { waiting }: Waits) =>
  childrenOf(tree, parentId).flatMap(({ node }) =>
    waiting(node.id) === 'made' ? [] : [{ id: node.id, position: node.position }],
  );

/**
 * Where `nodeId` lands in `parentId` just before `before`, or at the end for
 * null: its own position, and the others' to write first.
 */
export function landing(
  tree: Tree,
  waits: Waits,
  {
    nodeId,
    parentId,
    before,
  }: { nodeId: string; parentId: FolderId | null; before: string | null },
) {
  const children = ordered(tree, parentId, waits);
  // Before one made offline, which isn't ordered yet: before the next that is.
  const shown: string[] = childrenOf(tree, parentId).map(({ node }) => node.id);
  const ids = new Set<string>(children.map((child) => child.id));
  const from = before === null ? -1 : shown.indexOf(before);
  const next = from < 0 ? before : (shown.slice(from).find((id) => ids.has(id)) ?? null);
  return orderOperations.placing(children, nodeId, next);
}

/**
 * Whether Move up (-1) or Move down (1) can move `nodeId` in its folder: it
 * isn't first or last of what this app orders there.
 */
export function canStep(
  tree: Tree,
  waits: Waits,
  { nodeId, parentId }: { nodeId: string; parentId: FolderId | null },
  step: -1 | 1,
) {
  const children = ordered(tree, parentId, waits);
  const at = children.findIndex((child) => child.id === nodeId);
  return at >= 0 && at + step >= 0 && at + step < children.length;
}

// The folder's name, or the space's for its top, for a change made offline to name.
const placeName = (tree: Tree, parentId: FolderId | null) => {
  if (parentId === null) {
    const opened = tree.space?.metadata?.opened;
    return opened?.kind === 'current' ? opened.metadata.name : 'Space';
  }
  const folder = tree.folders.find((f) => f.id === parentId);
  return folder ? treeLabels.folder(folder) : 'Folder';
};

/** The server takes this many positions at once. */
const BATCH = 1000;

/**
 * Write positions in `parentId`: on the server, or on this device offline,
 * or while any of them, or the folder, has a change waiting, so they go
 * after it, all in one change to the folder (`OfflineQueue.order`).
 */
export async function writePositions(
  ctx: ClientContext,
  {
    tree,
    spaceId,
    parentId,
    writes,
    offline,
    waiting,
  }: {
    tree: Tree;
    spaceId: SpaceId;
    parentId: FolderId | null;
    writes: readonly PositionWrite[];
    offline: boolean;
  } & Waits,
) {
  if (writes.length === 0) return;
  // The folder's own changes, or for the top, the space's: an order waiting there.
  const waits =
    waiting(parentId ?? (spaceId as string as FolderId)) !== 'none' ||
    writes.some((write) => waiting(write.nodeId as PageId) !== 'none');
  if (!offline && !waits) {
    for (let i = 0; i < writes.length; i += BATCH) {
      await orderOperations.arrange(ctx, {
        spaceId,
        parentId,
        positions: writes.slice(i, i + BATCH),
      });
    }
    return;
  }
  await pageWriter(ctx).order({
    spaceId,
    parentId,
    name: placeName(tree, parentId),
    positions: writes,
  });
}

const quoted = (name: string) => (
  <>
    “<Name>{name}</Name>”
  </>
);

const reloaded = (queryClient: QueryClient, ctx: ClientContext, spaceId: SpaceId) =>
  contentChanged(queryClient, ctx, { spaceId });

/**
 * Reordering in the sidebar: `place` puts a page or folder where it was
 * dropped in its own folder, with a notice that offers Undo; `step` is Move
 * up and Move down, which say nothing, as the other undoes it; `sortByName`
 * lists a folder by name again, with Undo.
 */
export function useReorder(spaceId: SpaceId) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const availability = useAvailability();
  const write = async (tree: Tree, parentId: FolderId | null, writes: readonly PositionWrite[]) => {
    await writePositions(ctx, {
      tree,
      spaceId,
      parentId,
      writes,
      offline: availability.offline,
      waiting: availability.waiting,
    });
    await reloaded(queryClient, ctx, spaceId);
  };
  const shown = (tree: Tree, parentId: FolderId | null) =>
    childrenOf(tree, parentId).map(({ node }) => ({ id: node.id, position: node.position }));
  const failed = (caught: unknown) =>
    showNotice({ ctx, message: errorMessage(caught), failed: true });

  return {
    place(
      tree: Tree,
      {
        nodeId,
        name,
        parentId,
        before,
      }: { nodeId: string; name: string; parentId: FolderId | null; before: string | null },
    ) {
      const { own, others } = landing(tree, availability, { nodeId, parentId, before });
      const writes = [...others, own];
      const back = orderOperations.undoing(shown(tree, parentId), writes);
      void write(tree, parentId, writes).then(
        () =>
          showNotice({
            ctx,
            message: <>Moved {quoted(name)}.</>,
            undo: () => write(tree, parentId, back),
            undoMessage: errorMessage,
          }),
        failed,
      );
    },

    /** Move up or Move down; resolves once it is written. */
    async step(tree: Tree, nodeId: string, parentId: FolderId | null, by: -1 | 1) {
      const writes = orderOperations.stepping(ordered(tree, parentId, availability), nodeId, by);
      if (!writes) return;
      await write(tree, parentId, writes).catch(failed);
    },

    sortByName(tree: Tree, parentId: FolderId | null, name: string) {
      const back = shown(tree, parentId).flatMap(({ id, position }) =>
        position === null ? [] : [{ nodeId: id, position } as PositionWrite],
      );
      void orderOperations
        .sortByName(ctx, { spaceId, parentId })
        .then(() => reloaded(queryClient, ctx, spaceId))
        .then(
          () =>
            showNotice({
              ctx,
              message: <>Sorted {quoted(name)} by name.</>,
              undo: () => write(tree, parentId, back),
              undoMessage: errorMessage,
            }),
          failed,
        );
    },
  };
}
