import {
  foldersUnder,
  moveOperations,
  type ClientContext,
  type FolderId,
  type PageId,
  type SpaceId,
  type spaceOperations,
} from '@wikistow/client';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { failedToLoad, LoadFailed } from '@/components/load-failed';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Picker } from '@/components/ui/picker';
import { runCommand } from '../commands/command';
import { moveNode } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import { pageWriter } from '../data/offline-changes';
import { refreshAccess, sharedWithMeQuery, spacesQuery, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { SAVED_HERE, useAvailability, type MoveAvailability } from '../shell/availability';
import { THIS_DEVICE } from '../settings/rows';
import { PreviewTree } from '../sharing/first-share';
import { isStale } from '../sharing/messages';
import { nameOf } from '../sharing/names';
import { movesAsOwner, useOwnerStanding } from '../sharing/owner-standing';
import { describePerson, peopleQuery } from '../sharing/people';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { PLAIN, useClient } from '../vault/store';
import { askBeforeMoves, useAskBeforeMoves } from './ask-before-moves';
import { ConfirmCopy, openPlace, type Chosen } from './confirm-copy';
import { moveMessage } from './messages';
import {
  copyDestinations,
  copySpaces,
  crossesShare,
  moveDestinations,
  type Destination,
  type MoveTree,
} from './move-model';

/**
 * What is being moved or copied: a page or a folder, by the name the
 * person sees. A drop in the sidebar has already chosen where it goes
 * (`to`), in its own space, so the dialog opens on who gains and loses access.
 */
export type Moving = {
  id: FolderId | PageId;
  kind: 'folder' | 'page';
  name: string;
  /** Move to… (the default) or Copy to…. */
  action?: 'move' | 'copy';
  to?: Destination<FolderId>;
  /**
   * Why a drop moving without asking stopped, for the dialog it opens on:
   * something changed meanwhile, or what went wrong.
   */
  stopped?: 'stale' | { error: string };
  /** What a drop moving without asking worked out, for the dialog showing its progress. */
  preview?: moveOperations.MovePreview;
};

/**
 * Everything in a space, moved or copied into another space from its menu,
 * for its owners (#339). The space stays: after a move, they are asked
 * whether to delete it, empty, where it can be deleted.
 */
export type MovingSpace = {
  spaceId: SpaceId;
  name: string;
  action: 'move' | 'copy';
  /** False for a home space, which can't be deleted. */
  deletable: boolean;
};

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;

// What choosing a place needs of a space's tree.
const moveTreeOf = (tree: Tree): MoveTree<FolderId> => ({
  space: tree.space && { role: tree.space.role, opened: tree.space.metadata !== null },
  shares: tree.shares,
  folders: tree.folders.map((f) => ({ id: f.id, parentId: f.parentId, name: nameOf(f.metadata) })),
});

/** Where a page or folder in `tree` can move, for the dialog's picker and the sidebar's drops. */
export function destinationsIn(
  tree: Tree,
  moving: Pick<Moving, 'id' | 'kind'>,
  owner: boolean,
): Destination<FolderId>[] {
  const node =
    tree.folders.find((f) => f.id === moving.id) ?? tree.pages.find((p) => p.id === moving.id);
  if (!node) return [];
  return moveDestinations(
    moveTreeOf(tree),
    { id: node.id, kind: moving.kind, parentId: node.parentId },
    { owner },
  );
}

/**
 * How moving `moving`, in `tree`, its space's, under `parentId` goes now:
 * on the server, or on this device while offline or after a change waiting
 * here, or not now (`moveAvailability`).
 */
export function moveRoute(
  tree: Tree,
  moving: Pick<Moving, 'id'>,
  parentId: FolderId | null,
  availability: Pick<ReturnType<typeof useAvailability>, 'move'>,
): MoveAvailability {
  const node =
    tree.folders.find((f) => f.id === moving.id) ?? tree.pages.find((p) => p.id === moving.id);
  const across = !node || crossesShare(moveTreeOf(tree), node, parentId);
  return availability.move(moving.id, parentId, { across });
}

/** Move it on this device, sent once the server answers (#331). */
const moveOnDevice = (
  ctx: ClientContext,
  spaceId: SpaceId,
  moving: Moving,
  parentId: FolderId | null,
) =>
  pageWriter(ctx).moveNode({
    spaceId,
    nodeId: moving.id,
    node: moving.kind,
    name: moving.name,
    parentId,
  });

/**
 * Move or copy a page or folder: choose a space, then where in it it goes.
 * A move within its own space is the ordinary move (protocol section 10):
 * look over who gains and who loses access when that crosses a shared
 * folder's edge, then move it. A copy, or a move into another space, is a
 * copy (section 10, "Copies, and moves between spaces"; ADR 0007), which
 * always asks first. Opened from the page menu, the sidebar's menus, and a
 * drop in the sidebar.
 */
export function MoveDialog({
  spaceId,
  moving,
  onOpenChange,
}: {
  spaceId: SpaceId;
  /** Null while closed. */
  moving: Moving | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { locked, hold } = useHoldOpen();
  return (
    <Dialog open={moving !== null} onOpenChange={onOpenChange}>
      <DialogContent dialogClassName="sm:max-w-xl" locked={locked}>
        <HoldOpen value={hold}>
          {/* Afresh each time it opens, not each time its caller makes `moving` again. */}
          {moving && (
            <MoveSteps
              key={moving.id}
              spaceId={spaceId}
              moving={moving}
              onDone={() => onOpenChange(false)}
            />
          )}
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Move or copy everything in a space into another (#339), from the space's
 * menu. The app shell holds it, not the space's header, so it stays open
 * when the move's old addresses take the person to the other space, and on
 * a phone, where that header is in the drawer. `onDeleteSpace` deletes the
 * space, asking first, once everything moved out of it.
 */
export function SpaceMoveDialog({
  moving,
  onOpenChange,
  onDeleteSpace,
}: {
  /** Null while closed. */
  moving: MovingSpace | null;
  onOpenChange: (open: boolean) => void;
  onDeleteSpace: (spaceId: SpaceId) => void;
}) {
  const { locked, hold } = useHoldOpen();
  return (
    <Dialog open={moving !== null} onOpenChange={onOpenChange}>
      <DialogContent dialogClassName="sm:max-w-xl" locked={locked}>
        <HoldOpen value={hold}>
          {moving && (
            <SpaceSteps
              key={`${moving.spaceId} ${moving.action}`}
              moving={moving}
              onDone={() => onOpenChange(false)}
              onDeleteSpace={
                moving.deletable
                  ? () => {
                      onOpenChange(false);
                      onDeleteSpace(moving.spaceId);
                    }
                  : undefined
              }
            />
          )}
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Start a move whose place is already chosen, as a drop's is. With asking
 * before moves turned off it goes ahead at once, and `open`s the dialog only
 * when there is something to see there: the progress of a move that changes
 * keys, or why one stopped. Otherwise it opens the dialog to confirm.
 */
export function useStartMove(spaceId: SpaceId, open: (moving: Moving) => void) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const availability = useAvailability();
  return async (moving: Moving & { to: Destination<FolderId> }) => {
    if (askBeforeMoves.get()) return open(moving);
    const tree = queryClient.getQueryData(treeQuery(ctx, spaceId).queryKey);
    if (tree && moveRoute(tree, moving, moving.to.parentId, availability).route === 'device') {
      try {
        await moveOnDevice(ctx, spaceId, moving, moving.to.parentId);
      } catch (caught) {
        open({ ...moving, stopped: { error: errorMessage(caught) } });
      }
      return;
    }
    try {
      const preview = await moveOperations.previewMove(ctx, {
        spaceId,
        nodeId: moving.id,
        parentId: moving.to.parentId,
      });
      // Rewrapping can take a while: the dialog shows how far it has got.
      if (preview.crossing) return open({ ...moving, preview });
      await runCommand(moveNode, { preview }, { satisfies: requirementsHere(), ctx });
      await refreshMoved(queryClient, ctx);
    } catch (caught) {
      if (!isStale(caught))
        return open({ ...moving, stopped: { error: moveMessage(caught, moving.kind) } });
      // The dialog works it out again, never sent unseen.
      void queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
      open({ ...moving, stopped: 'stale' });
    }
  };
}

// What a move changes: who has access to what, and where pages are.
const refreshMoved = (queryClient: QueryClient, ctx: ClientContext) =>
  Promise.all([
    refreshAccess(queryClient, ctx),
    queryClient.invalidateQueries({ queryKey: [PLAIN, 'page'] }),
    queryClient.invalidateQueries({ queryKey: [PLAIN, 'history'] }),
  ]);

const DESCRIPTION = {
  move: {
    folder: 'Everything in the folder moves with it.',
    page: 'Its draft and published versions move with it.',
  },
  copy: {
    folder: 'Everything in the folder is copied: each page’s current draft and published version.',
    page: 'Its current draft and published version are copied, not its earlier versions.',
  },
};

// Choosing where it goes, then confirming; Back keeps the choice.
function MoveSteps({
  spaceId,
  moving,
  onDone,
}: {
  spaceId: SpaceId;
  moving: Moving;
  onDone: () => void;
}) {
  const ctx = useClient();
  const [action, setAction] = useState(moving.action ?? 'move');
  // A drop stays in its own space, which ConfirmMove names itself.
  const [chosen, setChosen] = useState<Chosen | null>(
    moving.to ? { spaceId, spaceName: '', place: moving.to } : null,
  );
  const [confirming, setConfirming] = useState(moving.to !== undefined);
  // What a drop moving without asking left, for the place dropped on only.
  const [dropped, setDropped] = useState<Pick<Moving, 'stopped' | 'preview'>>(moving);
  const back = () => {
    setDropped({});
    setConfirming(false);
  };
  // Offline, or after a change waiting here, a move within one share waits on this device.
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const availability = useAvailability();
  const onDevice =
    chosen !== null &&
    tree !== undefined &&
    moveRoute(tree, moving, chosen.place.parentId, availability).route === 'device';
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {action === 'copy' ? 'Copy' : 'Move'} “<Name>{moving.name}</Name>”
        </DialogTitle>
        <DialogDescription>{DESCRIPTION[action][moving.kind]}</DialogDescription>
      </DialogHeader>
      {chosen && confirming ? (
        action === 'move' && chosen.spaceId === spaceId && onDevice ? (
          <ConfirmOnDevice
            spaceId={spaceId}
            moving={moving}
            destination={chosen.place}
            error={typeof dropped.stopped === 'object' ? dropped.stopped.error : null}
            onBack={back}
            onDone={onDone}
          />
        ) : action === 'move' && chosen.spaceId === spaceId ? (
          <ConfirmMove
            spaceId={spaceId}
            moving={moving}
            destination={chosen.place}
            dropped={dropped}
            onBack={back}
            onDone={onDone}
          />
        ) : (
          <ConfirmCopy
            sourceSpaceId={spaceId}
            node={moving}
            copy={action === 'copy'}
            chosen={chosen}
            onBack={back}
            onDone={onDone}
          />
        )
      ) : (
        <ChooseDestination
          spaceId={spaceId}
          moving={moving}
          action={action}
          chosen={chosen}
          onCopyInstead={() => setAction('copy')}
          onChoose={(next) => {
            setChosen(next);
            setConfirming(true);
          }}
        />
      )}
    </div>
  );
}

const SPACE_DESCRIPTION = {
  move: 'Everything in it moves, with each page’s draft and published versions. The space stays, empty.',
  copy: 'Everything in it is copied: each page’s current draft and published version.',
};

/**
 * Everything in a space, into another (#339): choosing where, then the
 * usual preview. After a move, the space is empty, and its owner is asked
 * whether to delete it; it is never deleted unasked.
 */
function SpaceSteps({
  moving,
  onDone,
  onDeleteSpace,
}: {
  moving: MovingSpace;
  onDone: () => void;
  onDeleteSpace: (() => void) | undefined;
}) {
  const { spaceId } = moving;
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Where everything went, once a move finished.
  const [moved, setMoved] = useState<Chosen | null>(null);
  const copy = moving.action === 'copy';
  const goThere = async (to: Chosen) => {
    onDone();
    await openPlace(navigate, to);
  };
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {copy ? 'Copy' : 'Move'} everything in “<Name>{moving.name}</Name>”
        </DialogTitle>
        <DialogDescription>{SPACE_DESCRIPTION[moving.action]}</DialogDescription>
      </DialogHeader>
      {moved ? (
        <AskDeleteSpace
          name={moving.name}
          to={moved}
          onKeep={() => void goThere(moved)}
          onDelete={onDeleteSpace}
        />
      ) : chosen && confirming ? (
        <ConfirmCopy
          sourceSpaceId={spaceId}
          node={null}
          copy={copy}
          chosen={chosen}
          onBack={() => setConfirming(false)}
          onDone={onDone}
          onMoved={() => setMoved(chosen)}
        />
      ) : (
        <ChooseDestination
          spaceId={spaceId}
          moving={null}
          action={moving.action}
          chosen={chosen}
          onCopyInstead={() => {}}
          onChoose={(next) => {
            setChosen(next);
            setConfirming(true);
          }}
        />
      )}
    </div>
  );
}

/**
 * After everything in a space moved: it is empty, and its owner chooses
 * whether to delete it, as deleting a space does, or keep it. A home space
 * can't be deleted, so it is only said where everything went.
 */
function AskDeleteSpace({
  name,
  to,
  onKeep,
  onDelete,
}: {
  name: string;
  to: Chosen;
  onKeep: () => void;
  onDelete: (() => void) | undefined;
}) {
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="grid gap-4">
      <p ref={heading} tabIndex={-1} role="status" className="text-sm outline-none">
        Everything moved to{' '}
        <strong>
          <Name>{to.spaceName}</Name>
          {to.place.path.map((folder, i) => (
            <Fragment key={i}>
              {' › '}
              <Name>{folder}</Name>
            </Fragment>
          ))}
        </strong>
        . “<Name>{name}</Name>” is empty now.
        {onDelete && ' Do you want to delete it?'}
      </p>
      <DialogFooter>
        {onDelete ? (
          <>
            <Button variant="ghost" onClick={onKeep}>
              Keep the space
            </Button>
            <Button variant="destructive" onClick={onDelete}>
              Delete space…
            </Button>
          </>
        ) : (
          <Button onClick={onKeep}>Go there</Button>
        )}
      </DialogFooter>
    </div>
  );
}

const SPACE_GONE = 'The space you picked is no longer available. Choose again.';
const FOLDER_GONE = 'The folder you picked is no longer available. Choose again.';

/**
 * A space, its own first, then where in it: for a move within its own
 * space, where `moveDestinations` allows, from the tree as it is now;
 * otherwise anywhere the person can make pages, but not inside what is
 * copied. A copy never goes into a folder made offline that isn't sent yet.
 * Only an owner of the space moves it into another (ADR 0007, decision 2):
 * anyone else is told so, and offered a copy. Offline, or after a change
 * waiting here, a move stays in its space and its share (`moveRoute`).
 * Everything in a space (`moving` null) goes only into another space, which
 * the person picks: none is picked at first.
 */
function ChooseDestination({
  spaceId,
  moving,
  action,
  chosen,
  onCopyInstead,
  onChoose,
}: {
  spaceId: SpaceId;
  /** Null for everything in the space. */
  moving: Moving | null;
  action: 'move' | 'copy';
  /** The place chosen before going back, shown chosen again. */
  chosen: Chosen | null;
  onCopyInstead: () => void;
  onChoose: (chosen: Chosen) => void;
}) {
  const ctx = useClient();
  const id = useId();
  const sourceLoad = useQuery(treeQuery(ctx, spaceId));
  const source = sourceLoad.data;
  // Whether this person may move as an owner, once known: until then a
  // place picked that only an owner can reach would read as gone. Spaces
  // that fail to load leave them moving within this space, as anyone else.
  const spacesLoad = useQuery(spacesQuery(ctx));
  const sharedLoad = useQuery(sharedWithMeQuery(ctx));
  const standing = useOwnerStanding(spaceId);
  const availability = useAvailability();
  const known = !spacesLoad.isPending && (standing !== 'checking' || availability.offline);
  const owner = movesAsOwner(standing, availability.offline);
  // Without them, this space alone, by its tree (named by its shared folders if they hold only those).
  const spaces =
    spacesLoad.data ??
    (failedToLoad(spacesLoad) && source
      ? source.space
        ? [{ id: spaceId, metadata: source.space.metadata, role: source.space.role }]
        : []
      : undefined);
  // Folders shared with them count too; a list that fails leaves them out.
  const shared = sharedLoad.data ?? (sharedLoad.isError ? [] : undefined);
  const choices = useMemo(
    () =>
      spaces && shared
        ? copySpaces(
            {
              spaces: spaces.map((s) => ({ id: s.id, name: nameOf(s.metadata), role: s.role })),
              shared: shared.map((item) => ({
                spaceId: item.share.spaceId,
                rootName: nameOf(item.root),
                role: item.role,
              })),
            },
            spaceId,
          )
        : null,
    [spaces, shared, spaceId],
  );
  // A move waiting on this device stays in this space (#331).
  const local =
    availability.offline || (moving !== null && availability.waiting(moving.id) !== 'none');
  const movesAcross = source?.space?.role === 'owner';
  const offered =
    moving === null
      ? choices?.slice(1)
      : action === 'move' && (!movesAcross || local)
        ? choices?.slice(0, 1)
        : choices;
  const [toSpace, setToSpace] = useState<SpaceId | null>(
    chosen?.spaceId ?? (moving ? spaceId : null),
  );
  const space = offered?.find((c) => c.spaceId === toSpace);
  const treeLoad = useQuery({
    ...treeQuery(ctx, toSpace ?? spaceId),
    enabled: space !== undefined,
  });
  const tree = treeLoad.data;
  const within = action === 'move' && toSpace === spaceId;
  const allowed = useMemo(() => {
    if (!tree) return null;
    if (within && moving) return known ? destinationsIn(tree, moving, owner) : null;
    // A copy in its own space goes anywhere but inside itself.
    const inside =
      toSpace === spaceId && moving?.kind === 'folder'
        ? foldersUnder(tree.folders, moving.id)
        : new Set<string>();
    return copyDestinations(moveTreeOf(tree), inside);
  }, [tree, within, known, moving, owner, toSpace, spaceId]);
  // A copy goes into no folder made offline until it is sent: the server doesn't have it.
  const places =
    allowed?.filter((d) =>
      within && tree && moving
        ? moveRoute(tree, moving, d.parentId, availability).route !== null
        : availability.of(d.parentId).can('into'),
    ) ?? null;
  // The place picked, by its folder; until the person picks, the first.
  // If a refetch no longer offers it, nothing is picked until they pick again.
  const [picked, setPicked] = useState<FolderId | null | undefined>(chosen?.place.parentId);
  if (!offered) {
    // Without this space's tree, there is nothing to offer even within it.
    return failedToLoad(sourceLoad) ? (
      <LoadFailed what="your spaces" queries={[sourceLoad, spacesLoad]} />
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }
  const index = picked === undefined ? 0 : (places?.findIndex((d) => d.parentId === picked) ?? -1);
  const place = places?.[index];
  // Everything in a space needs something in it, and another space to go to.
  const empty =
    moving === null && source !== undefined && [...source.folders, ...source.pages].length === 0;
  const label = (d: Destination, spaceName: string) =>
    d.parentId === null ? `Top of ${plainText(spaceName)}` : d.path.map(plainText).join(' › ');
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (space && place && !empty)
          onChoose({ spaceId: space.spaceId, spaceName: space.name, place });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-space`}>Space</Label>
        <Picker
          id={`${id}-space`}
          label="Space"
          placeholder="Choose a space"
          value={space?.spaceId ?? null}
          options={offered.map((c) => ({
            value: c.spaceId,
            label: `${plainText(c.name)}${
              c.spaceId === spaceId
                ? ' (this space)'
                : c.folderOnly
                  ? ' (a folder shared with you)'
                  : ''
            }`,
          }))}
          autoFocus
          onChange={(value) => {
            const next = offered.find((c) => c.spaceId === value);
            if (!next) return;
            setToSpace(next.spaceId);
            setPicked(undefined);
          }}
        />
        <ErrorLine error={space || toSpace === null ? null : SPACE_GONE} />
        {moving === null && offered.length === 0 && (
          <p className="text-sm text-muted-foreground">
            You have no other space where you can make pages.
          </p>
        )}
        {empty && <p className="text-sm text-muted-foreground">There’s nothing in this space.</p>}
        {/* This space is offered without them, for a move or copy within it. */}
        <LoadFailed what="your other spaces" queries={[spacesLoad]} />
        {action === 'move' && source && !movesAcross && !local && choices && choices.length > 1 && (
          <p className="text-sm text-muted-foreground">
            Only an owner of this space can move things into another space. You can copy it there
            instead.{' '}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => {
                onCopyInstead();
                // The button goes; the spaces it can be copied to are next.
                document.getElementById(`${id}-space`)?.focus();
              }}
            >
              Copy instead
            </Button>
          </p>
        )}
      </div>
      {space && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-to`}>Folder</Label>
          {!places ? (
            failedToLoad(treeLoad) ? (
              <LoadFailed what="the folders in this space" queries={[treeLoad]} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )
          ) : places.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {within && availability.offline
                ? 'Offline, there’s nowhere here you can move it without changing who can read it.'
                : within
                  ? 'There’s nowhere here you can move it. Inside a shared folder, you can move things only within that folder; an owner of the space can move them anywhere.'
                  : 'There’s nowhere here you can make pages. Choose another space.'}
            </p>
          ) : (
            <>
              <Picker
                id={`${id}-to`}
                label="Folder"
                placeholder="Choose where it goes"
                value={place ? String(index) : null}
                options={places.map((d, i) => ({ value: String(i), label: label(d, space.name) }))}
                onChange={(value) => {
                  const next = places[Number(value)];
                  if (next) setPicked(next.parentId);
                }}
              />
              <ErrorLine error={place ? null : FOLDER_GONE} />
              {within && availability.offline && (
                <p className="text-sm text-muted-foreground">
                  Offline, it moves only where the same people can read it.
                </p>
              )}
            </>
          )}
        </div>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!place || !space || empty}>
          Next
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Where it goes, which focus goes to after Next, so a screen reader starts with what is being confirmed. */
function MoveHeading({
  spaceId,
  destination,
}: {
  spaceId: SpaceId;
  destination: Destination<FolderId>;
}) {
  const ctx = useClient();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  // Named as the picker named it.
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const spaceName = nameOf(tree?.space?.metadata) ?? 'this space';
  return (
    <h3 ref={heading} tabIndex={-1} className="text-sm outline-none">
      To{' '}
      <strong>
        {destination.parentId === null ? (
          <>
            the top of <Name>{spaceName}</Name>
          </>
        ) : (
          // Each name kept apart, so one holding " › " or right-to-left text reads as one.
          destination.path.map((folder, i) => (
            <Fragment key={i}>
              {i > 0 && ' › '}
              <Name>{folder}</Name>
            </Fragment>
          ))
        )}
      </strong>
      .
    </h3>
  );
}

/**
 * A move within one share, offline or after a change waiting here: nobody
 * gains or loses access, and it waits on this device, sent after what was
 * made before it (#331). The server checks it again then.
 */
function ConfirmOnDevice({
  spaceId,
  moving,
  destination,
  error: earlier,
  onBack,
  onDone,
}: {
  spaceId: SpaceId;
  moving: Moving;
  destination: Destination<FolderId>;
  /** Why a drop moving without asking stopped. */
  error: string | null;
  onBack: () => void;
  onDone: () => void;
}) {
  const ctx = useClient();
  const { offline } = useAvailability();
  const { busy, error, run } = useAction((caught) => moveMessage(caught, moving.kind));
  const asking = useAskBeforeMoves();
  const [dontAsk, setDontAsk] = useState(false);
  const move = () =>
    run(async () => {
      if (dontAsk) askBeforeMoves.set(false);
      await moveOnDevice(ctx, spaceId, moving, destination.parentId);
      onDone();
    });
  return (
    <div className="grid gap-4">
      <MoveHeading spaceId={spaceId} destination={destination} />
      <p className="rounded-control bg-muted p-3 text-sm">
        Nobody gains or loses access: it stays with the same people.{' '}
        {offline ? SAVED_HERE : 'It’s sent after your change made offline.'}
      </p>
      <ErrorLine error={error ?? earlier} />
      {asking && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dontAsk}
            disabled={busy}
            onChange={(event) => setDontAsk(event.target.checked)}
          />
          Don’t ask again on {THIS_DEVICE.toLowerCase()}
        </label>
      )}
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <Button disabled={busy} onClick={() => void move()}>
          Move
        </Button>
      </DialogFooter>
    </div>
  );
}

const REACH: Record<moveOperations.Reach, string> = {
  drafts: 'drafts and published versions',
  published: 'published versions',
};

const CHANGED = 'Something changed meanwhile. Check the move again, then confirm.';

/**
 * Who gains and who loses, worked out afresh: it is what the person
 * confirms. With asking before moves turned off, it moves as soon as it's
 * worked out, unless a move made without asking stopped already.
 */
function ConfirmMove({
  spaceId,
  moving,
  destination,
  dropped,
  onBack,
  onDone,
}: {
  spaceId: SpaceId;
  moving: Moving;
  destination: Destination<FolderId>;
  dropped: Pick<Moving, 'stopped' | 'preview'>;
  onBack: () => void;
  onDone: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { busy, error, run } = useAction((caught) => moveMessage(caught, moving.kind));
  // How far the rewrapping has got, once the server has counted what moves.
  const [progress, setProgress] = useState<{ records: number; total: number | null } | null>(null);
  const [notice, setNotice] = useState(dropped.stopped === 'stale' ? CHANGED : null);
  const [earlier, setEarlier] = useState(
    typeof dropped.stopped === 'object' ? dropped.stopped.error : null,
  );
  const asking = useAskBeforeMoves();
  const [dontAsk, setDontAsk] = useState(false);
  // As it was when this step opened, so Don't ask again doesn't move it too.
  const [auto] = useState(() => !askBeforeMoves.get() && dropped.stopped === undefined);
  const tried = useRef(false);
  const preview = useQuery({
    queryKey: [PLAIN, 'move-preview', spaceId, moving.id, destination.parentId],
    queryFn: () =>
      moveOperations.previewMove(ctx, {
        spaceId,
        nodeId: moving.id,
        parentId: destination.parentId,
      }),
    // A drop's, worked out a moment ago, isn't worked out again.
    initialData: dropped.preview,
    staleTime: dropped.preview ? Infinity : 0,
    gcTime: 0,
    retry: false,
  });
  const shown = preview.data;
  const ids = shown
    ? [
        ...[...shown.gains, ...shown.losses].map((c) => c.identityId),
        ...shown.endingPicks.map((a) => a.personId),
      ]
    : [];
  const { data: people } = useQuery(peopleQuery(ctx, ids));
  const name = (identityId: string) =>
    (people?.get(identityId) ?? describePerson(ctx, identityId, null)).name;
  // Only a move across matters: it gives access to what moves.
  const unreadable = shown?.crossing
    ? shown.folders.filter((f) => nameOf(f.metadata) === null).length +
      shown.pages.filter((p) => p.title === null).length
    : 0;

  const move = (confirmed: moveOperations.MovePreview) => {
    tried.current = true;
    return run(async () => {
      setProgress(confirmed.crossing ? { records: 0, total: null } : null);
      setNotice(null);
      setEarlier(null);
      try {
        await runCommand(
          moveNode,
          { preview: confirmed },
          {
            satisfies: requirementsHere(),
            ctx,
            onProgress: setProgress,
          },
        );
      } catch (caught) {
        if (!isStale(caught)) throw caught;
        // Worked out again and shown again, never sent unseen.
        await Promise.all([
          preview.refetch(),
          queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey }),
        ]);
        setNotice(CHANGED);
        return;
      } finally {
        setProgress(null);
      }
      await refreshMoved(queryClient, ctx);
      onDone();
    });
  };
  const movable = shown !== undefined && !preview.isError && unreadable === 0;
  useEffect(() => {
    if (auto && movable && !tried.current) void move(shown);
  });

  return (
    <div className="grid gap-4">
      <MoveHeading spaceId={spaceId} destination={destination} />
      {notice && !preview.isError && (
        <p role="status" className="text-sm font-bold">
          {notice}
        </p>
      )}
      {preview.error && (
        <ErrorLine
          error={
            isStale(preview.error)
              ? 'Something changed since you chose where it goes. Go back and check again.'
              : moveMessage(preview.error, moving.kind)
          }
        />
      )}
      {!shown && !preview.error && (
        <p className="text-sm text-muted-foreground">Working out who gains and loses access…</p>
      )}
      {shown && !shown.crossing && (
        <p className="rounded-control bg-muted p-3 text-sm">
          Nobody gains or loses access: it stays with the same people, and no keys change.
        </p>
      )}
      {shown?.crossing && (
        <>
          <section aria-label="Who gains access" className="grid gap-2">
            <h3 className="text-sm font-bold text-subtle-foreground">
              At least these people gain access
            </h3>
            {shown.gains.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody new.</p>
            ) : (
              <ul className="grid gap-1 text-sm">
                {shown.gains.map((change) => (
                  <li key={change.identityId}>
                    <strong>
                      <Name>{name(change.identityId)}</Name>
                    </strong>{' '}
                    gets {change.after ? REACH[change.after] : ''}
                    {change.before && ` (has ${REACH[change.before]} only now)`}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              The server could keep someone with access from this list, so there may be more. Once
              you move it, anyone who gains access keeps the keys to everything in it, even if you
              move it back.
            </p>
          </section>
          <section aria-label="Who loses access" className="grid gap-2">
            <h3 className="text-sm font-bold text-subtle-foreground">These people lose access</h3>
            {shown.losses.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody.</p>
            ) : (
              <ul className="grid gap-1 text-sm">
                {shown.losses.map((change) => (
                  <li key={change.identityId}>
                    <strong>
                      <Name>{name(change.identityId)}</Name>
                    </strong>{' '}
                    {change.after ? `keeps ${REACH[change.after]} only` : 'loses access'}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              They keep anything they already read or downloaded, but not what is saved after the
              move.
            </p>
          </section>
          {shown.endingPicks.length > 0 && (
            <section aria-label="Agents whose folder ends" className="grid gap-2">
              <h3 className="text-sm font-bold text-subtle-foreground">
                These agents lose the folder they were given
              </h3>
              <ul className="grid gap-1 text-sm">
                {shown.endingPicks.map((agent) => (
                  <li key={agent.agentId}>
                    <strong>
                      <Name>{agent.name}</Name>
                    </strong>
                    , <Name>{name(agent.personId)}</Name>’s agent
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Each could reach a folder in what moves. Its person can add one again on the Agents
                page.
              </p>
            </section>
          )}
          {/* From the preview, not the menu: what is shown here is what gets new keys. */}
          <section aria-label="What moves" className="grid gap-2">
            <h3 className="text-sm font-bold text-subtle-foreground">What moves</h3>
            <PreviewTree
              preview={{
                spaceId,
                rootId:
                  shown.kind === 'folder'
                    ? (shown.folders.find((f) => f.id === shown.nodeId)?.id ?? null)
                    : shown.fromParentId,
                folders: shown.folders,
                pages: shown.pages,
              }}
            />
          </section>
          {unreadable > 0 && (
            <p role="alert" className="text-sm text-destructive">
              This app can’t read {unreadable === 1 ? 'one item' : `${unreadable} items`} here, so
              it won’t move this across: you’d be giving access to something you can’t check.
            </p>
          )}
        </>
      )}
      {progress !== null && (
        <p role="status" className="text-sm font-bold">
          Moving…{' '}
          {progress.total !== null &&
            `${progress.records.toLocaleString()} of ${progress.total.toLocaleString()} done. `}
          Keep this open until it’s done.
        </p>
      )}
      <ErrorLine error={error ?? (preview.isError ? null : earlier)} />
      {asking && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dontAsk}
            disabled={busy}
            onChange={(event) => setDontAsk(event.target.checked)}
          />
          Don’t ask again on {THIS_DEVICE.toLowerCase()}
        </label>
      )}
      <DialogFooter>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            // Where it can go, from the tree as it is now.
            void queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
            onBack();
          }}
        >
          Back
        </Button>
        <Button
          disabled={busy || !movable}
          onClick={() => {
            if (!movable) return;
            if (dontAsk) askBeforeMoves.set(false);
            void move(shown);
          }}
        >
          Move
        </Button>
      </DialogFooter>
    </div>
  );
}
