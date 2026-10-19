import {
  moveOperations,
  type ClientContext,
  type FolderId,
  type PageId,
  type SpaceId,
  type spaceOperations,
} from '@wikistow/client';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
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
import { refreshAccess, spacesQuery, treeQuery } from '../data/queries';
import { THIS_DEVICE } from '../settings/rows';
import { PreviewTree } from '../sharing/first-share';
import { isStale } from '../sharing/messages';
import { nameOf } from '../sharing/names';
import { useOwnerStanding } from '../sharing/owner-standing';
import { describePerson, peopleQuery } from '../sharing/people';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { PLAIN, useClient } from '../vault/store';
import { askBeforeMoves, useAskBeforeMoves } from './ask-before-moves';
import { moveMessage } from './messages';
import { moveDestinations, type Destination } from './move-model';

/**
 * What is being moved: a page or a folder, by the name the person sees.
 * A drop in the sidebar has already chosen where it goes (`to`), so the
 * dialog opens on who gains and loses access.
 */
export type Moving = {
  id: FolderId | PageId;
  kind: 'folder' | 'page';
  name: string;
  to?: Destination<FolderId>;
  /**
   * Why a move made without asking stopped, for the dialog it opens on:
   * something changed meanwhile, or what went wrong.
   */
  stopped?: 'stale' | { error: string };
};

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;

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
    {
      space: tree.space && { role: tree.space.role, opened: tree.space.metadata !== null },
      shares: tree.shares,
      folders: tree.folders.map((f) => ({
        id: f.id,
        parentId: f.parentId,
        name: nameOf(f.metadata),
      })),
    },
    { id: node.id, kind: moving.kind, parentId: node.parentId },
    { owner },
  );
}

/**
 * Move a page or folder (protocol section 10): choose where it goes, look
 * over who gains and who loses access when that crosses a shared folder's
 * edge, then move it. Opened from the page menu, the folder menu, and a
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
 * Start a move whose place is already chosen, as a drop's is. With asking
 * before moves turned off it goes ahead at once, and `open`s the dialog only
 * when there is something to see there: the progress of a move that changes
 * keys, or why one stopped. Otherwise it opens the dialog to confirm.
 */
export function useStartMove(spaceId: SpaceId, open: (moving: Moving) => void) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  return async (moving: Moving & { to: Destination<FolderId> }) => {
    if (askBeforeMoves.get()) return open(moving);
    try {
      const preview = await moveOperations.previewMove(ctx, {
        spaceId,
        nodeId: moving.id,
        parentId: moving.to.parentId,
      });
      // Rewrapping can take a while: the dialog shows how far it has got.
      if (preview.crossing) return open(moving);
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
  const [chosen, setChosen] = useState(moving.to ?? null);
  const [confirming, setConfirming] = useState(moving.to !== undefined);
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Move “<Name>{moving.name}</Name>”
        </DialogTitle>
        <DialogDescription>
          {moving.kind === 'folder'
            ? 'Everything in the folder moves with it.'
            : 'Its draft and every published version move with it.'}
        </DialogDescription>
      </DialogHeader>
      {chosen && confirming ? (
        <ConfirmMove
          spaceId={spaceId}
          moving={moving}
          destination={chosen}
          onBack={() => setConfirming(false)}
          onDone={onDone}
        />
      ) : (
        <ChooseDestination
          spaceId={spaceId}
          moving={moving}
          chosen={chosen}
          onChoose={(destination) => {
            setChosen(destination);
            setConfirming(true);
          }}
        />
      )}
    </div>
  );
}

const FOLDER_GONE = 'The folder you picked is no longer available. Choose again.';

// Where it can go, as `moveDestinations` allows, from the tree as it is now.
function ChooseDestination({
  spaceId,
  moving,
  chosen,
  onChoose,
}: {
  spaceId: SpaceId;
  moving: Moving;
  /** The place chosen before going back, shown chosen again. */
  chosen: Destination<FolderId> | null;
  onChoose: (destination: Destination<FolderId>) => void;
}) {
  const ctx = useClient();
  const id = useId();
  const treeLoad = useQuery(treeQuery(ctx, spaceId));
  const tree = treeLoad.data;
  // Whether this person may move as an owner, once known: until then a
  // place picked that only an owner can reach would read as gone. Spaces
  // that fail to load leave them moving as anyone else.
  const spaces = useQuery(spacesQuery(ctx));
  const standing = useOwnerStanding(spaceId);
  const known = !spaces.isPending && standing !== 'checking';
  const spaceName = nameOf(tree?.space?.metadata) ?? 'this space';
  const places = useMemo(
    () => (tree && known ? destinationsIn(tree, moving, standing === 'owner') : null),
    [tree, known, moving, standing],
  );
  // The place picked, by its folder; until the person picks, the first.
  // If a refetch no longer offers it, nothing is picked until they pick again.
  const [picked, setPicked] = useState<FolderId | null | undefined>(chosen?.parentId);
  if (!places) {
    return failedToLoad(treeLoad) ? (
      <LoadFailed what="the folders here" queries={[treeLoad]} />
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }
  const index = picked === undefined ? 0 : places.findIndex((d) => d.parentId === picked);
  const place = places[index];
  if (places.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        There’s nowhere you can move it. Inside a shared folder, you can move things only within
        that folder; an owner of the space can move them anywhere.
      </p>
    );
  }
  const label = (d: Destination) =>
    d.parentId === null ? `Top of ${plainText(spaceName)}` : d.path.map(plainText).join(' › ');
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (place) onChoose(place);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-to`}>Move to</Label>
        <Picker
          id={`${id}-to`}
          label="Move to"
          placeholder="Choose where it goes"
          value={place ? String(index) : null}
          options={places.map((d, i) => ({ value: String(i), label: label(d) }))}
          autoFocus
          onChange={(value) => {
            const next = places[Number(value)];
            if (next) setPicked(next.parentId);
          }}
        />
        <ErrorLine error={place ? null : FOLDER_GONE} />
      </div>
      <DialogFooter>
        <Button type="submit" disabled={!place}>
          Next
        </Button>
      </DialogFooter>
    </form>
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
  onBack,
  onDone,
}: {
  spaceId: SpaceId;
  moving: Moving;
  destination: Destination<FolderId>;
  onBack: () => void;
  onDone: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { busy, error, run } = useAction((caught) => moveMessage(caught, moving.kind));
  // How far the rewrapping has got, once the server has counted what moves.
  const [progress, setProgress] = useState<{ records: number; total: number | null } | null>(null);
  const [notice, setNotice] = useState(moving.stopped === 'stale' ? CHANGED : null);
  const [earlier, setEarlier] = useState(
    typeof moving.stopped === 'object' ? moving.stopped.error : null,
  );
  const asking = useAskBeforeMoves();
  const [dontAsk, setDontAsk] = useState(false);
  // As it was when this step opened, so Don't ask again doesn't move it too.
  const [auto] = useState(() => !askBeforeMoves.get() && moving.stopped === undefined);
  const tried = useRef(false);
  const preview = useQuery({
    queryKey: [PLAIN, 'move-preview', spaceId, moving.id, destination.parentId],
    queryFn: () =>
      moveOperations.previewMove(ctx, {
        spaceId,
        nodeId: moving.id,
        parentId: destination.parentId,
      }),
    staleTime: 0,
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
  const unreadable = shown
    ? shown.folders.filter((f) => nameOf(f.metadata) === null).length +
      shown.pages.filter((p) => p.title === null).length
    : 0;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  // Named as the picker named it.
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const spaceName = nameOf(tree?.space?.metadata) ?? 'this space';

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
      {/* Where focus goes after Next, so a screen reader starts with what is being confirmed. */}
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
