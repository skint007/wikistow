import {
  foldersUnder,
  moveOperations,
  type FolderId,
  type PageId,
  type SpaceId,
  type spaceOperations,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { sharedWithMeQuery, spacesQuery, treeQuery } from '../data/queries';
import { SAVED_HERE, useAvailability, type MoveAvailability } from '../shell/availability';
import { isStale } from '../sharing/messages';
import { nameOf } from '../sharing/names';
import { movesAsOwner, useOwnerStanding } from '../sharing/owner-standing';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { UnreadableCommentFix } from '../comments/unreadable';
import { PLAIN, useClient } from '../vault/store';
import { askBeforeMoves } from './ask-before-moves';
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
import {
  landWhereDropped,
  restoring,
  moveNotes,
  MoveNotesLines,
  moveNow,
  moveOnDevice,
  MoveRefused,
  noteMoved,
  parentIn,
  refreshMoved,
  undoMove,
  undoOnDevice,
  unreadableIn,
  unreadableMessage,
  useQuietMove,
  type Drop,
} from './quiet-moves';

/**
 * What is being moved or copied: a page or a folder, by the name the
 * person sees. While **Ask before moving** is on, a drop in the sidebar
 * opens the dialog on the place dropped on (`to`), in its own space, and a
 * drop on another space's tile in the rail on that space (`into`), its top
 * picked.
 */
export type Moving = {
  id: FolderId | PageId;
  kind: 'folder' | 'page';
  name: string;
  /** Move to… (the default) or Copy to…. */
  action?: 'move' | 'copy';
  to?: Destination<FolderId>;
  /** Dropped on a line between rows of `to`: it lands just before this, or last for null (#400). */
  before?: string | null;
  into?: SpaceId;
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

/** Where a copy of a page or folder in `tree` can go in that space: anywhere the person can make pages but inside itself. */
export const copyDestinationsIn = (tree: Tree, moving: Pick<Moving, 'id' | 'kind'>) =>
  copyDestinations(
    moveTreeOf(tree),
    moving.kind === 'folder' ? foldersUnder(tree.folders, moving.id) : new Set<string>(),
  );

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

/**
 * Move or copy a page or folder, in one step (#376): choose a space and
 * where in it it goes, then Move or Copy. A move within its own space is
 * the ordinary move (protocol section 10); a copy, or a move into another
 * space, is a copy (section 10, "Copies, and moves between spaces"; ADR
 * 0007). Under the place chosen, a line says when more people will be able
 * to read it, and another what a move ends. Then a notice offers Undo.
 * Opened from the page menu, the sidebar's menus, and while **Ask before
 * moving** is on, a drop in the sidebar or on a space in the rail (`SpaceMoves`).
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
 * Start a drop's move or copy, whose place is already chosen (#376): at
 * once, with a notice and Undo (`useQuietMove`), or, while **Ask before
 * moving** is on, by `open`ing Move to… or Copy to… on that place, for one
 * press of Move or Copy.
 */
export function useStartMove(open: (spaceId: SpaceId, moving: Moving) => void) {
  const quiet = useQuietMove();
  return (drop: Drop) => {
    const { spaceId, moving, action, to } = drop;
    if (!askBeforeMoves.get()) return quiet(drop);
    open(
      spaceId,
      to.spaceId === spaceId
        ? {
            ...moving,
            action,
            to: to.place,
            ...(drop.before !== undefined && { before: drop.before }),
          }
        : { ...moving, action, into: to.spaceId },
    );
  };
}

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

// Where it goes, in one step: pressing Move or Copy does it (#376).
function MoveSteps({
  spaceId,
  moving,
  onDone,
}: {
  spaceId: SpaceId;
  moving: Moving;
  onDone: () => void;
}) {
  const [action, setAction] = useState(moving.action ?? 'move');
  // While it runs, the place stays as chosen.
  const [busy, setBusy] = useState(false);
  const label = action === 'copy' ? 'Copy' : 'Move';
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {label} “<Name>{moving.name}</Name>”
        </DialogTitle>
        <DialogDescription>{DESCRIPTION[action][moving.kind]}</DialogDescription>
      </DialogHeader>
      <ChooseDestination
        spaceId={spaceId}
        moving={moving}
        action={action}
        // A drop stays in its own space, whose name the picker shows.
        chosen={moving.to ? { spaceId, spaceName: '', place: moving.to } : null}
        disabled={busy}
        onCopyInstead={() => setAction('copy')}
        footer={(chosen) =>
          !chosen ? (
            <DialogFooter>
              <Button disabled>{label}</Button>
            </DialogFooter>
          ) : action === 'move' && chosen.spaceId === spaceId ? (
            <MoveHere
              key={`${chosen.spaceId} ${chosen.place.parentId}`}
              spaceId={spaceId}
              moving={moving}
              chosen={chosen}
              onBusy={setBusy}
              onDone={onDone}
            />
          ) : (
            <ConfirmCopy
              key={`${action} ${chosen.spaceId} ${chosen.place.parentId}`}
              sourceSpaceId={spaceId}
              node={moving}
              copy={action === 'copy'}
              chosen={chosen}
              onBusy={setBusy}
              onDone={onDone}
            />
          )
        }
      />
    </div>
  );
}

const SPACE_DESCRIPTION = {
  move: 'Everything in it moves, with each page’s draft and published versions. The space stays, empty.',
  copy: 'Everything in it is copied: each page’s current draft and published version.',
};

/**
 * Everything in a space, into another (#339): choosing where, then a step
 * of its own to confirm, as it can't be undone (#376). After a move, the space is empty, and its owner is asked
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
  disabled = false,
  onCopyInstead,
  onChoose,
  footer,
}: {
  spaceId: SpaceId;
  /** Null for everything in the space. */
  moving: Moving | null;
  action: 'move' | 'copy';
  /** The place chosen at first: dropped on, or chosen before going back. */
  chosen: Chosen | null;
  /** While a move or copy runs: the place stays as chosen. */
  disabled?: boolean;
  onCopyInstead: () => void;
  /** Next, for a step after this one. */
  onChoose?: (chosen: Chosen) => void;
  /** In place of Next: what goes under the place picked, and the button that moves it there. */
  footer?: (chosen: Chosen | null) => ReactNode;
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
    chosen?.spaceId ?? (moving ? (moving.into ?? spaceId) : null),
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
  const picking =
    space && place && !empty ? { spaceId: space.spaceId, spaceName: space.name, place } : null;
  const label = (d: Destination, spaceName: string) =>
    d.parentId === null ? `Top of ${plainText(spaceName)}` : d.path.map(plainText).join(' › ');
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (picking) onChoose?.(picking);
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
          disabled={disabled}
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
              disabled={disabled}
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
                disabled={disabled}
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
      {footer ? (
        footer(picking)
      ) : (
        <DialogFooter>
          <Button type="submit" disabled={!picking}>
            Next
          </Button>
        </DialogFooter>
      )}
    </form>
  );
}

const CHANGED =
  'Something changed meanwhile, so nothing moved. Check where it goes, then press Move again.';

/**
 * A move within its own space, from the dialog: Move moves it. One that
 * crosses a shared folder's edge is worked out first, so its notes show
 * under the place before Move is pressed; it rewraps keys, which the dialog
 * shows the progress of. Offline, or after a change waiting here, it waits
 * on this device (#331). Then a notice says where it went, with Undo.
 */
function MoveHere({
  spaceId,
  moving,
  chosen,
  onBusy,
  onDone,
}: {
  spaceId: SpaceId;
  moving: Moving;
  chosen: Chosen;
  onBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const availability = useAvailability();
  const { busy, error, failure, run } = useAction((caught) =>
    caught instanceof MoveRefused ? caught.message : moveMessage(caught, moving.kind),
  );
  useEffect(() => onBusy(busy), [busy, onBusy]);
  // How far the rewrapping has got, once the server has counted what moves.
  const [progress, setProgress] = useState<{ records: number; total: number | null } | null>(null);
  const [changed, setChanged] = useState(false);
  const { parentId } = chosen.place;
  const node =
    tree?.folders.find((f) => f.id === moving.id) ?? tree?.pages.find((p) => p.id === moving.id);
  const route = tree ? moveRoute(tree, moving, parentId, availability).route : null;
  // Only a move across a share's edge has notes: who gains access, and agents' folders that end.
  const crossing =
    tree !== undefined && node !== undefined && crossesShare(moveTreeOf(tree), node, parentId);
  const preview = useQuery({
    queryKey: [PLAIN, 'move-preview', spaceId, moving.id, parentId],
    queryFn: () => moveOperations.previewMove(ctx, { spaceId, nodeId: moving.id, parentId }),
    enabled: route === 'server' && crossing,
    gcTime: 0,
    retry: false,
    // Worked out again only when a move finds something changed.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const shown = preview.data;
  const unreadable = shown ? unreadableIn(shown) : 0;
  const ready =
    route === 'device' ||
    (route === 'server' && (!crossing || (shown !== undefined && unreadable === 0)));

  const move = () =>
    run(async () => {
      if (!tree) return;
      setChanged(false);
      const back = { spaceId, moving, parentId: parentIn(tree, moving), position: node?.position };
      // Where it was dropped, if this is the place it was dropped on (#400).
      const landed = await landWhereDropped(ctx, availability, {
        tree,
        spaceId,
        nodeId: moving.id,
        parentId,
        before: moving.to?.parentId === parentId ? moving.before : undefined,
      });
      const position = landed?.position;
      let undo;
      // Unless it moved, the folder it was dropped in lists as it did.
      let moved = false;
      try {
        if (route === 'device') {
          await moveOnDevice(ctx, spaceId, moving, parentId, position);
          moved = true;
          undo = restoring(undoOnDevice(ctx, back), landed);
        } else {
          const confirmed =
            shown && position === undefined
              ? shown
              : await moveOperations.previewMove(ctx, {
                  spaceId,
                  nodeId: moving.id,
                  parentId,
                  ...(position !== undefined && { position }),
                });
          // It crosses after all, which the tree didn't show: its notes come first.
          if (confirmed.crossing && !shown) {
            await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
            setChanged(true);
            return;
          }
          setProgress(confirmed.crossing ? { records: 0, total: null } : null);
          try {
            await moveNow(ctx, confirmed, setProgress);
          } catch (caught) {
            if (!isStale(caught)) throw caught;
            await Promise.all([
              crossing && preview.refetch(),
              queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey }),
            ]);
            setChanged(true);
            return;
          } finally {
            setProgress(null);
          }
          moved = true;
          await refreshMoved(queryClient, ctx);
          undo = restoring(undoMove(ctx, queryClient, back), landed);
        }
      } finally {
        if (!moved) await landed?.restore().catch(() => {});
      }
      onDone();
      noteMoved(ctx, { moving, to: chosen, sameSpace: true, copy: false, undo });
    });

  return (
    <>
      {route === 'device' && (
        <p className="text-sm text-muted-foreground">
          {availability.offline ? SAVED_HERE : 'It’s sent after your change made offline.'}
        </p>
      )}
      {shown && tree && <MoveNotesLines notes={moveNotes(tree, shown, chosen.spaceName)} />}
      {crossing && preview.isPending && route === 'server' && (
        <p className="text-sm text-muted-foreground">Checking where it goes…</p>
      )}
      {unreadable > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {unreadableMessage(unreadable)}
        </p>
      )}
      {changed && (
        <p role="status" className="text-sm font-bold">
          {CHANGED}
        </p>
      )}
      {progress !== null && (
        <p role="status" className="text-sm font-bold">
          Moving…{' '}
          {progress.total !== null &&
            `${progress.records.toLocaleString()} of ${progress.total.toLocaleString()} done. `}
          Keep this open until it’s done.
        </p>
      )}
      <ErrorLine
        error={
          error ??
          (preview.error
            ? isStale(preview.error)
              ? 'Something changed since you chose where it goes. Look again.'
              : moveMessage(preview.error, moving.kind)
            : null)
        }
      />
      <UnreadableCommentFix failure={failure} spaceId={spaceId} />
      <DialogFooter>
        {preview.isError && !busy && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              // Where it can go, and what it crosses, from the tree as it is now.
              void queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
              void preview.refetch();
            }}
          >
            Look again
          </Button>
        )}
        <Button type="button" disabled={busy || !ready} onClick={() => void move()}>
          Move
        </Button>
      </DialogFooter>
    </>
  );
}
