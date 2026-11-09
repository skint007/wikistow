import {
  copyOperations,
  moveOperations,
  spaceOperations,
  type ClientContext,
  type FolderId,
  type PageId,
  type Region,
  type SpaceId,
} from '@wikistow/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Fragment, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { runCommand } from '../commands/command';
import { copyNode, moveNode } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import { contentChanged } from '../data/content-changed';
import { pageWriter } from '../data/offline-changes';
import { refreshAccess, spacesQuery, trashQuery, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { isStale } from '../sharing/messages';
import { nameOf, shareName } from '../sharing/names';
import { useAvailability } from '../shell/availability';
import { PLAIN, useClient } from '../vault/store';
import type { Chosen } from './confirm-copy';
import { READ_BUDGET_MS } from './markdown-worker';
import { copyMessage, FinishUnknown, moveMessage, namedPages, PagesRefused } from './messages';
import { moveRoute, type Moving } from './move-dialog';
import { pageReader } from './page-reader';
import { showNotice, type Notice } from './undo-notice';

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;

/**
 * The two things a move or copy says (#376), each only when it applies: who
 * will be able to read it that can't now, by the shared folder or space it
 * goes into, and what the move ends. Losing access goes unsaid.
 */
export type MoveNotes = {
  reaches: { who: 'members' | 'owners'; name: string; folder: boolean } | null;
  ends: Ends | null;
};

type Ends = {
  shares: string[];
  agents: string[];
  publicLinks: string[];
  publications: { page: string; space: string }[];
  /** Pages that arrive without their published version, as the mover can't publish there. */
  unpublished: string[];
  /** Earlier versions, which a move into another space leaves out. */
  history: boolean;
};

const NO_ENDS: Ends = {
  shares: [],
  agents: [],
  publicLinks: [],
  publications: [],
  unpublished: [],
  history: false,
};

const titleOf = (title: string | null) => (title?.trim() ? title : 'Untitled');

// Who reads `region` of `tree`: the owners of the space, or a share's members, by its folder or space.
function readersOf(
  tree: Tree | undefined,
  region: Region,
  spaceName: string,
): MoveNotes['reaches'] {
  if (region.kind === 'owner') return { who: 'owners', name: spaceName, folder: false };
  const rootId = tree?.shares.find((s) => s.shareId === region.shareId)?.rootId ?? null;
  return rootId === null
    ? { who: 'members', name: spaceName, folder: false }
    : { who: 'members', name: shareName(tree, rootId), folder: true };
}

/** What a move within one space says: who gains access to it, and agents whose folder ends. */
export const moveNotes = (
  tree: Tree | undefined,
  preview: moveOperations.MovePreview,
  spaceName: string,
): MoveNotes => ({
  reaches: preview.gains.length > 0 ? readersOf(tree, preview.to, spaceName) : null,
  ends:
    preview.endingPicks.length > 0
      ? { ...NO_ENDS, agents: preview.endingPicks.map((agent) => agent.name) }
      : null,
});

/**
 * What a copy, or a move into another space, says: who can read it there
 * that can't now, or everyone there when that can't be told, and for a move,
 * what it ends, earlier versions always among them.
 */
export function copyNotes(
  tree: Tree | undefined,
  preview: copyOperations.CopyPreview,
  spaceName: string,
  spaces: readonly { id: string; metadata: Parameters<typeof nameOf>[0] }[] | undefined,
): MoveNotes {
  const names = new Map(preview.nodes.map((n) => [n.sourceId, titleOf(n.name)]));
  const named = (id: string) => names.get(id) ?? 'Untitled';
  const { ends } = preview;
  return {
    reaches:
      preview.gains === null || preview.gains.length > 0
        ? readersOf(tree, preview.destination.region, spaceName)
        : null,
    ends: ends && {
      shares: ends.shares.map((share) => named(share.rootId)),
      agents: ends.agentPicks.map((agent) => agent.name),
      publicLinks: ends.publicLinks.map(named),
      publications: ends.publications.map(({ pageId, spaceId }) => ({
        page: named(pageId),
        space: nameOf(spaces?.find((s) => s.id === spaceId)?.metadata) ?? 'another space',
      })),
      unpublished: preview.unpublished
        .filter((page) => !ends.publicLinks.includes(page.pageId))
        .map((page) => titleOf(page.title)),
      history: true,
    },
  };
}

const quoted = (name: string) => (
  <>
    “<Name>{name}</Name>”
  </>
);

// "a", "a and b", "a, b and c".
function listed(items: ReactNode[]) {
  return items.map((item, i) => (
    <Fragment key={i}>
      {i > 0 && (i === items.length - 1 ? ' and ' : ', ')}
      {item}
    </Fragment>
  ));
}

// One of a kind by its name, or how many.
const one = (names: string[], each: (name: string) => ReactNode, many: string) =>
  names.length === 0 ? [] : [names.length === 1 ? each(names[0] ?? '') : many];

/** The notes that apply, one line each, under the place chosen or in the notice after a drop. */
export function MoveNotesLines({ notes }: { notes: MoveNotes | null }) {
  if (!notes) return null;
  const { reaches, ends } = notes;
  const ended = ends
    ? [
        ...one(
          ends.shares,
          (name) => <>sharing {quoted(name)}</>,
          `sharing ${ends.shares.length} folders`,
        ),
        ...one(
          ends.agents,
          (name) => (
            <>
              the folder the agent <Name>{name}</Name> was given
            </>
          ),
          `the folders ${ends.agents.length} agents were given`,
        ),
        ...one(
          ends.publicLinks,
          (name) => <>the public link of {quoted(name)}</>,
          `${ends.publicLinks.length} public links`,
        ),
        ...(ends.publications.length === 1 && ends.publications[0]
          ? [
              <>
                updates to {quoted(ends.publications[0].page)} published in{' '}
                <Name>{ends.publications[0].space}</Name>
              </>,
            ]
          : ends.publications.length > 1
            ? [`updates to ${ends.publications.length} pages published in other spaces`]
            : []),
        ...one(
          ends.unpublished,
          (name) => <>the published version of {quoted(name)}</>,
          `the published versions of ${ends.unpublished.length} pages`,
        ),
      ]
    : [];
  return (
    <>
      {reaches && (
        <p className="text-sm">
          {reaches.who === 'owners' ? 'Owners' : 'Members'} of{' '}
          {reaches.folder ? quoted(reaches.name) : <Name>{reaches.name}</Name>} will be able to read
          it.
        </p>
      )}
      {ends && (ended.length > 0 || ends.history) && (
        <p className="text-sm">
          {ended.length > 0 && <>It ends {listed(ended)}</>}
          {ended.length > 0 && (ends.history ? ', and its' : '.')}
          {ends.history && `${ended.length > 0 ? '' : 'Its'} earlier versions don’t go with it.`}
        </p>
      )}
    </>
  );
}

/** Where it went, as a notice says it: in this space by its folder, or in another by the space too. */
export function placeLabel(to: Chosen, sameSpace: boolean): ReactNode {
  const path = to.place.path.map((folder, i) => (
    <Fragment key={i}>
      {i > 0 && ' › '}
      <Name>{folder}</Name>
    </Fragment>
  ));
  if (sameSpace) {
    return to.place.parentId === null ? (
      <>
        the top of <Name>{to.spaceName}</Name>
      </>
    ) : (
      path
    );
  }
  return (
    <>
      <Name>{to.spaceName}</Name>
      {to.place.path.length > 0 && ' › '}
      {path}
    </>
  );
}

/** Move it on this device, sent once the server answers (#331). */
export const moveOnDevice = (
  ctx: ClientContext,
  spaceId: SpaceId,
  moving: Pick<Moving, 'id' | 'kind' | 'name'>,
  parentId: FolderId | null,
) =>
  pageWriter(ctx).moveNode({
    spaceId,
    nodeId: moving.id,
    node: moving.kind,
    name: moving.name,
    parentId,
  });

// What a move changes: who has access to what, and where pages are.
export const refreshMoved = (queryClient: QueryClient, ctx: ClientContext) =>
  Promise.all([
    refreshAccess(queryClient, ctx),
    queryClient.invalidateQueries({ queryKey: [PLAIN, 'page'] }),
    queryClient.invalidateQueries({ queryKey: [PLAIN, 'history'] }),
  ]);

/**
 * How many items a move across a share's edge would give access to that
 * this app can't read: it won't move those across, since nobody checked them.
 */
export const unreadableIn = (preview: moveOperations.MovePreview) =>
  preview.crossing
    ? preview.folders.filter((f) => nameOf(f.metadata) === null).length +
      preview.pages.filter((p) => p.title === null).length
    : 0;

export const unreadableMessage = (count: number) =>
  `This app can’t read ${count === 1 ? 'one item' : `${count} items`} here, so it won’t move this across: you’d be giving access to something you can’t check.`;

/** A refusal this app makes itself, in its own words. */
export class MoveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveRefused';
  }
}

/** Make a move within one space, as worked out: it changes keys when it crosses a share's edge. */
export async function moveNow(
  ctx: ClientContext,
  preview: moveOperations.MovePreview,
  onProgress?: (progress: { records: number; total: number | null }) => void,
) {
  const unreadable = unreadableIn(preview);
  if (unreadable > 0) throw new MoveRefused(unreadableMessage(unreadable));
  await runCommand(
    moveNode,
    { preview },
    { satisfies: requirementsHere(), ctx, ...(onProgress && { onProgress }) },
  );
}

/**
 * Make a copy, or a move into another space, as worked out. A finish whose
 * answer was lost may have made it (`FinishUnknown`); a refusal naming
 * pages says which and why (`PagesRefused`). Stopped by `signal` before
 * its finish was sent, it throws `copyOperations.CopyStopped`.
 */
export async function copyNow(
  ctx: ClientContext,
  preview: copyOperations.CopyPreview,
  {
    onProgress,
    signal,
  }: { onProgress?: (progress: copyOperations.CopyProgress) => void; signal?: AbortSignal } = {},
): Promise<copyOperations.MadeCopy> {
  let made: copyOperations.MadeCopy | null = null;
  try {
    await runCommand(
      copyNode,
      { preview },
      {
        satisfies: requirementsHere(),
        ctx,
        ...(onProgress && { onProgress }),
        ...(signal && { signal }),
        onMade: (copied) => {
          made = copied;
        },
      },
    );
  } catch (caught) {
    // Left for its finish, whose answer was lost or which stayed busy.
    if (caught instanceof copyOperations.CopyKept) throw new FinishUnknown();
    const pageIds = namedPages(caught);
    if (!pageIds) throw caught;
    // Both refusals naming pages are `forbidden`: a page the source's
    // tree lists with no version has nothing to copy.
    const { pages } = await spaceOperations
      .loadTree(ctx, preview.source.spaceId)
      .catch(() => ({ pages: [] }));
    const empty = pages.filter((p) => p.draftHead === null && p.publishedHead === null);
    throw new PagesRefused(
      pageIds.every((id) => empty.some((p) => p.id === id))
        ? 'nothing-to-copy'
        : 'published-elsewhere',
      pageIds,
    );
  }
  if (!made) throw new Error('The copy made nothing');
  return made;
}

/** Both trees, after a copy or a move into another space, and who has access, after a move. */
export async function refreshCopied(
  queryClient: QueryClient,
  ctx: ClientContext,
  preview: copyOperations.CopyPreview,
  made: copyOperations.MadeCopy,
) {
  await contentChanged(queryClient, ctx, [
    { spaceId: preview.source.spaceId },
    { spaceId: made.spaceId },
  ]);
  if (preview.kind !== 'move') return;
  void refreshAccess(queryClient, ctx);
  // A page open where it was is gone now: loaded again, it follows its old address.
  void queryClient.invalidateQueries({ queryKey: [PLAIN, 'page'] });
}

/** Work out a copy, or a move into another space, reading links off the page's thread. */
export const previewCopy = (
  ctx: ClientContext,
  {
    kind,
    spaceId,
    nodeId,
    to,
    signal,
  }: {
    kind: 'copy' | 'move';
    spaceId: SpaceId;
    nodeId: FolderId | PageId | null;
    to: { spaceId: SpaceId; parentId: FolderId | null };
    signal?: AbortSignal;
  },
) =>
  copyOperations.previewCopy(ctx, {
    kind,
    source: { spaceId, nodeId },
    destination: to,
    read: (markdown) =>
      pageReader.run('links', markdown, { budgetMs: READ_BUDGET_MS, ...(signal && { signal }) }),
  });

/** How a move or copy is taken back, and what its failure says. */
export type Undo = { run: () => Promise<void>; message: (error: unknown) => string };

type Moved = {
  moving: Pick<Moving, 'name'>;
  to: Chosen;
  sameSpace: boolean;
  copy: boolean;
  /** Null for a move into a space the mover doesn't own, which only its owners move out of. */
  undo: Undo | null;
  /** After a drop, which no dialog showed them before. */
  notes?: MoveNotes | null;
};

const movedNotice = (
  ctx: ClientContext,
  { moving, to, sameSpace, copy, undo, notes }: Moved,
): Notice => ({
  ctx,
  message: (
    <>
      {copy ? 'Copied' : 'Moved'} {quoted(moving.name)} to {placeLabel(to, sameSpace)}.
    </>
  ),
  ...((notes || !undo) && {
    notes: (
      <>
        <MoveNotesLines notes={notes ?? null} />
        {!undo && (
          <p className="text-sm">
            Only an owner of <Name>{to.spaceName}</Name> can move it out again.
          </p>
        )}
      </>
    ),
  }),
  ...(undo && { undo: undo.run, undoMessage: undo.message }),
});

/** Say where a move or copy went, with Undo (`UndoNotice`). */
export const noteMoved = (ctx: ClientContext, moved: Moved) => showNotice(movedNotice(ctx, moved));

/** Take back a move within one space: move it back where it was, worked out afresh. */
export function undoMove(
  ctx: ClientContext,
  queryClient: QueryClient,
  { spaceId, moving, parentId }: { spaceId: SpaceId; moving: Moving; parentId: FolderId | null },
): Undo {
  return {
    run: async () => {
      const preview = await moveOperations.previewMove(ctx, {
        spaceId,
        nodeId: moving.id,
        parentId,
      });
      await moveNow(ctx, preview);
      await refreshMoved(queryClient, ctx);
    },
    message: (caught) =>
      caught instanceof MoveRefused ? caught.message : moveMessage(caught, moving.kind),
  };
}

/** Take back a move waiting on this device: it waits to go back where it was instead. */
export const undoOnDevice = (
  ctx: ClientContext,
  { spaceId, moving, parentId }: { spaceId: SpaceId; moving: Moving; parentId: FolderId | null },
): Undo => ({
  run: () => moveOnDevice(ctx, spaceId, moving, parentId),
  message: (caught) => moveMessage(caught, moving.kind),
});

/**
 * Take back a copy, by putting the copy in the trash, or a move into
 * another space, by moving it back where it was: its old addresses follow
 * it there (ADR 0007, decision 9), and its public links come back with it.
 * Only an owner of a space moves things out of it (decision 2), so a move
 * into a space the mover doesn't own has no Undo (null).
 */
export function undoCopy(
  ctx: ClientContext,
  queryClient: QueryClient,
  {
    preview,
    made,
    moving,
    fromParentId,
    ownsDestination,
  }: {
    preview: copyOperations.CopyPreview;
    made: copyOperations.MadeCopy;
    moving: Moving;
    /** Where what moved was. */
    fromParentId: FolderId | null;
    /** Whether the mover owns the space it went to. */
    ownsDestination: boolean;
  },
): Undo | null {
  if (preview.kind === 'copy') {
    return {
      run: async () => {
        await pageWriter(ctx).deleteNode({
          spaceId: made.spaceId,
          nodeId: made.nodeId,
          node: moving.kind,
          name: moving.name,
        });
        await Promise.all([
          contentChanged(queryClient, ctx, { spaceId: made.spaceId }),
          queryClient.invalidateQueries({ queryKey: trashQuery(ctx).queryKey }),
        ]);
      },
      message: errorMessage,
    };
  }
  if (!ownsDestination) return null;
  return {
    run: async () => {
      const back = await previewCopy(ctx, {
        kind: 'move',
        spaceId: made.spaceId,
        nodeId: made.nodeId,
        to: { spaceId: preview.source.spaceId, parentId: fromParentId },
      });
      const returned = await copyNow(ctx, back);
      await refreshCopied(queryClient, ctx, back, returned);
    },
    message: (caught) => copyMessage(caught, false, 'dropped'),
  };
}

/** Where a page or folder is in `tree`, for Undo to put it back. */
export const parentIn = (tree: Tree, moving: Pick<Moving, 'id'>) =>
  (tree.folders.find((f) => f.id === moving.id) ?? tree.pages.find((p) => p.id === moving.id))
    ?.parentId ?? null;

/** A page or folder dropped where it goes, to move or copy there without a dialog. */
export type Drop = {
  spaceId: SpaceId;
  moving: Moving;
  action: 'move' | 'copy';
  to: Chosen;
};

/**
 * Move or copy a drop at once (#376): no dialog, and a notice in the
 * corner says how it's going, then what happened, the notes that apply and
 * Undo, or why it couldn't. Something changed meanwhile is worked out again
 * once. Rewrapping, or copying, can take a while: the notice stays until
 * it's done.
 */
export function useQuietMove() {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const availability = useAvailability();
  return (drop: Drop) => {
    const { moving, action, to, spaceId } = drop;
    const sameSpace = to.spaceId === spaceId;
    const what = quoted(moving.name);
    const copy = action === 'copy';
    const notice = showNotice({
      ctx,
      message: (
        <>
          {copy ? 'Copying' : 'Moving'} {what}…
        </>
      ),
      running: true,
    });
    // Said even after a later notice took the corner, so neither its notes nor a failure are missed.
    const say = (next: Notice) => {
      if (!notice.update(next)) showNotice(next);
    };
    const done = (notes: MoveNotes | null, undo: Undo | null) =>
      say(movedNotice(ctx, { moving, to, sameSpace, copy, undo, notes }));
    const failed = (message: string) => say({ ctx, message, failed: true });

    async function moveHere() {
      const tree = await queryClient.ensureQueryData(treeQuery(ctx, spaceId));
      const node =
        tree.folders.find((f) => f.id === moving.id) ?? tree.pages.find((p) => p.id === moving.id);
      if (!node) throw new MoveRefused('That page or folder isn’t there any more.');
      const back = { spaceId, moving, parentId: node.parentId };
      const route = moveRoute(tree, moving, to.place.parentId, availability);
      if (route.route === null) throw new MoveRefused(route.hint ?? 'It can’t move there now.');
      if (route.route === 'device') {
        await moveOnDevice(ctx, spaceId, moving, to.place.parentId);
        return done(null, undoOnDevice(ctx, back));
      }
      const work = () =>
        moveOperations.previewMove(ctx, {
          spaceId,
          nodeId: moving.id,
          parentId: to.place.parentId,
        });
      let preview = await work();
      try {
        await moveNow(ctx, preview);
      } catch (caught) {
        if (!isStale(caught)) throw caught;
        // Worked out again, once: nothing was shown to go stale.
        preview = await work();
        await moveNow(ctx, preview);
      }
      await refreshMoved(queryClient, ctx);
      done(moveNotes(tree, preview, to.spaceName), undoMove(ctx, queryClient, back));
    }

    async function copyThere() {
      const [source, tree, spaces] = await Promise.all([
        queryClient.ensureQueryData(treeQuery(ctx, spaceId)),
        queryClient.ensureQueryData(treeQuery(ctx, to.spaceId)),
        queryClient.ensureQueryData(spacesQuery(ctx)).catch(() => undefined),
      ]);
      const preview = await previewCopy(ctx, {
        kind: action,
        spaceId,
        nodeId: moving.id,
        to: { spaceId: to.spaceId, parentId: to.place.parentId },
      });
      const made = await copyNow(ctx, preview);
      await refreshCopied(queryClient, ctx, preview, made);
      done(
        copyNotes(tree, preview, to.spaceName, spaces),
        undoCopy(ctx, queryClient, {
          preview,
          made,
          moving,
          fromParentId: parentIn(source, moving),
          ownsDestination: tree.space?.role === 'owner',
        }),
      );
    }

    const within = !copy && sameSpace;
    void (within ? moveHere() : copyThere()).catch((caught: unknown) =>
      failed(
        caught instanceof MoveRefused
          ? caught.message
          : within
            ? moveMessage(caught, moving.kind)
            : copyMessage(caught, copy, 'dropped'),
      ),
    );
  };
}
