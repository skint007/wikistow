import { copyOperations, type FolderId, type PageId, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { PLAIN, useClient } from '../vault/store';
import { spacesQuery, treeQuery } from '../data/queries';
import { isStale } from '../sharing/messages';
import { ErrorLine, useAction } from '../sharing/use-action';
import { copyMessage, FinishUnknown, PagesRefused } from './messages';
import type { Destination } from './move-model';
import {
  copyNotes,
  copyNow,
  MoveNotesLines,
  noteMoved,
  parentIn,
  previewCopy,
  refreshCopied,
  undoCopy,
} from './quiet-moves';

/** Where the person chose to put it: a space, by the name they saw, and a place in it. */
export type Chosen = { spaceId: SpaceId; spaceName: string; place: Destination<FolderId> };

/** Open the place chosen: its folder, or the top of its space. */
export const openPlace = (navigate: ReturnType<typeof useNavigate>, to: Chosen) =>
  to.place.parentId === null
    ? navigate({ to: '/s/$spaceId', params: { spaceId: to.spaceId } })
    : navigate({
        to: '/s/$spaceId/f/$folderId',
        params: { spaceId: to.spaceId, folderId: to.place.parentId },
      });

/**
 * A copy, or a move into another space (ADR 0007), worked out as the place
 * is chosen, with the notes that apply (#376): who will be able to read it
 * there that can't now, and what a move ends. Then Copy or Move runs it,
 * showing how far it has got, and opens what it made, with a notice that
 * offers Undo. For everything in a space (`node` null), a step of its own
 * after choosing, with Back, which a move can't be undone from: it opens the
 * place chosen, or after a move, leaves the dialog to `onMoved`.
 */
export function ConfirmCopy({
  sourceSpaceId,
  node,
  copy,
  chosen,
  onBack,
  onBusy,
  onDone,
  onMoved,
}: {
  sourceSpaceId: SpaceId;
  /** Null for everything in the space. */
  node: { id: FolderId | PageId; kind: 'folder' | 'page'; name: string } | null;
  /** False for a move into another space. */
  copy: boolean;
  chosen: Chosen;
  /** Back to choosing, for a step of its own. */
  onBack?: () => void;
  /** Whether it runs, so the place chosen stays as it is meanwhile. */
  onBusy?: (busy: boolean) => void;
  onDone: () => void;
  /** Once a move finished, in place of closing and opening what it made. */
  onMoved?: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { busy, error, setError, run } = useAction((caught) => copyMessage(caught, copy));
  useEffect(() => onBusy?.(busy), [busy, onBusy]);
  const [progress, setProgress] = useState<copyOperations.CopyProgress | null>(null);
  // The pages a refusal named, by source ID, and why.
  const [blocked, setBlocked] = useState<PagesRefused | null>(null);
  const [stopped, setStopped] = useState(false);
  // Its finish may have made it (`FinishUnknown`), so it isn't offered again.
  const [unsure, setUnsure] = useState(false);
  // Aborted by Stop; a new one for each try.
  const stopping = useRef<AbortController | null>(null);
  const [stopAsked, setStopAsked] = useState(false);
  // A preview's copy is tried once: after it fails or stops, it's worked out again.
  const [spent, setSpent] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: [
      PLAIN,
      'copy-preview',
      copy,
      sourceSpaceId,
      node?.id ?? null,
      chosen.spaceId,
      chosen.place.parentId,
    ],
    queryFn: ({ signal }) =>
      previewCopy(ctx, {
        kind: copy ? 'copy' : 'move',
        spaceId: sourceSpaceId,
        nodeId: node?.id ?? null,
        to: { spaceId: chosen.spaceId, parentId: chosen.place.parentId },
        signal,
      }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    // Worked out again only by Look again: never while a copy runs, and
    // never as a fresh copy whose notes weren't shown.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const shown = preview.data;
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const { data: sourceTree } = useQuery(treeQuery(ctx, sourceSpaceId));
  const { data: destTree } = useQuery(treeQuery(ctx, chosen.spaceId));
  // What is copied, by the names this app opened them by.
  const names = new Map(shown?.nodes.map((n) => [n.sourceId, n.name?.trim() || 'Untitled']));
  const named = (sourceId: string) => names.get(sourceId) ?? 'Untitled';
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const nothing = copy ? 'Nothing was copied.' : 'Nothing moved.';

  const go = (confirmed: copyOperations.CopyPreview) =>
    run(async () => {
      // Where it was, for Undo to put it back.
      const fromParentId = node && sourceTree ? parentIn(sourceTree, node) : null;
      setSpent(confirmed.copyId);
      setBlocked(null);
      setStopped(false);
      setUnsure(false);
      const stop = new AbortController();
      stopping.current = stop;
      setStopAsked(false);
      setProgress({ stage: 'sending', sent: 0, total: confirmed.nodes.length });
      let made: copyOperations.MadeCopy;
      try {
        made = await copyNow(ctx, confirmed, { onProgress: setProgress, signal: stop.signal });
      } catch (caught) {
        // Stopped before its finish was sent: the copy is deleted.
        if (caught instanceof copyOperations.CopyStopped) {
          setStopped(true);
          return;
        }
        if (caught instanceof FinishUnknown) setUnsure(true);
        if (caught instanceof PagesRefused) setBlocked(caught);
        throw caught;
      } finally {
        setProgress(null);
      }
      const { spaceId, nodeId } = made;
      // Both trees, before opening what it made there.
      await refreshCopied(queryClient, ctx, confirmed, made);
      if (!copy && onMoved) {
        onMoved();
        return;
      }
      // Closed first: a dialog left open would be shown again for the space it went to.
      onDone();
      if (node) {
        const undo = undoCopy(ctx, queryClient, {
          preview: confirmed,
          made,
          moving: node,
          fromParentId,
          ownsDestination: destTree?.space?.role === 'owner',
        });
        noteMoved(ctx, {
          moving: node,
          to: chosen,
          sameSpace: chosen.spaceId === sourceSpaceId,
          copy,
          undo: undo && {
            ...undo,
            // A copy undone goes to the trash: off it, back to what it copied.
            run: async () => {
              await undo.run();
              if (copy && window.location.pathname.includes(nodeId))
                await navigate(addressOf(sourceSpaceId, node));
            },
          },
        });
      }
      await (node === null
        ? openPlace(navigate, chosen)
        : navigate(addressOf(spaceId, { id: nodeId, kind: node.kind })));
    });
  // It stops before the next node or attachment is sealed, and cancels the copy.
  const stop = () => {
    stopping.current?.abort();
    setStopAsked(true);
  };
  const lookAgain = () => {
    setError(null);
    setBlocked(null);
    setStopped(false);
    void preview.refetch();
  };
  const confirmable = shown !== undefined && !preview.isError && shown.copyId !== spent;
  // Once tried, unless it may have been made, or when the preview failed
  // other than for a change meanwhile, which goes back to choose again.
  const offerLookAgain =
    !busy &&
    !unsure &&
    ((shown !== undefined && shown.copyId === spent) ||
      (preview.isError && (!isStale(preview.error) || !onBack)));
  // Focus moves on from a button that goes: from Stop, once it has run, to
  // Look again or Back; from Look again, once looked at again, to Copy or
  // Move. After a failed preview, Look again goes before Copy can be pressed.
  const footer = useRef<HTMLDivElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const againButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const was = useRef({ busy, offerLookAgain });
  const toConfirm = useRef(false);
  useEffect(() => {
    if (was.current.busy && !busy)
      (againButton.current ?? backButton.current ?? confirmButton.current)?.focus();
    else if (was.current.offerLookAgain && !offerLookAgain) toConfirm.current = true;
    if (toConfirm.current && confirmable) {
      toConfirm.current = false;
      if (!footer.current?.contains(document.activeElement)) confirmButton.current?.focus();
    }
    was.current = { busy, offerLookAgain };
  }, [busy, offerLookAgain, confirmable]);

  return (
    <div className="grid gap-4">
      {onBack && (
        // Where focus goes after Next, so a screen reader starts with what is being confirmed.
        <h3 ref={heading} tabIndex={-1} className="text-sm outline-none">
          To{' '}
          <strong>
            {chosen.place.parentId === null ? (
              <>
                the top of <Name>{chosen.spaceName}</Name>
              </>
            ) : (
              <>
                <Name>{chosen.spaceName}</Name>
                {chosen.place.path.map((folder, i) => (
                  <Fragment key={i}>
                    {' › '}
                    <Name>{folder}</Name>
                  </Fragment>
                ))}
              </>
            )}
          </strong>
          .
        </h3>
      )}
      {preview.error && (
        <ErrorLine
          error={
            isStale(preview.error)
              ? onBack
                ? 'Something changed since you chose where it goes. Go back and check again.'
                : 'Something changed since you chose where it goes. Look again.'
              : copyMessage(preview.error, copy, false)
          }
        />
      )}
      {!shown && !preview.error && (
        <p className="text-sm text-muted-foreground">Checking where it goes…</p>
      )}
      {shown && <MoveNotesLines notes={copyNotes(destTree, shown, chosen.spaceName, spaces)} />}
      {shown && !copy && node === null && (
        <p role="note" className="rounded-control bg-muted p-3 text-sm">
          <strong>This can’t be undone.</strong> Once everything is there, it is deleted here. The
          space itself stays, empty.
        </p>
      )}
      {progress !== null && (
        <div className="grid gap-2">
          <p role="status" className="text-sm font-bold">
            {progress.stage === 'finishing'
              ? 'Finishing… '
              : `${copy ? 'Copying' : 'Moving'}… ${progress.sent.toLocaleString()} of ${progress.total.toLocaleString()} done. `}
            Keep this open until it’s done.
          </p>
          <div
            role="progressbar"
            aria-label={copy ? 'Copy progress' : 'Move progress'}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.sent}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            {/* Set through the CSSOM, which the style policy allows. */}
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{
                width: `${progress.total > 0 ? (100 * progress.sent) / progress.total : 0}%`,
              }}
            />
          </div>
        </div>
      )}
      {stopped && (
        <p role="status" className="text-sm font-bold">
          Stopped. {nothing}
        </p>
      )}
      <ErrorLine error={error} />
      {blocked && (
        <ul
          aria-label={
            blocked.reason === 'published-elsewhere'
              ? 'Pages to detach first'
              : 'Pages with nothing to copy'
          }
          className="grid list-disc gap-1 pl-5 text-sm"
        >
          {blocked.pageIds.map((pageId) => (
            <li key={pageId}>
              <Name>{named(pageId)}</Name>
            </li>
          ))}
        </ul>
      )}
      <DialogFooter ref={footer}>
        {busy ? (
          // Only while it sends: once the finish is sent, it no longer stops.
          <Button
            type="button"
            variant="ghost"
            disabled={progress?.stage !== 'sending' || stopAsked}
            onClick={stop}
          >
            Stop
          </Button>
        ) : onBack ? (
          <Button ref={backButton} type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        ) : (
          // It may be there already, so nothing is offered again: the way on is to look.
          unsure && (
            <Button ref={backButton} type="button" variant="ghost" onClick={onDone}>
              Close
            </Button>
          )
        )}
        {offerLookAgain && (
          <Button ref={againButton} type="button" variant="secondary" onClick={lookAgain}>
            Look again
          </Button>
        )}
        <Button
          ref={confirmButton}
          type="button"
          disabled={busy || !confirmable}
          onClick={() => shown && void go(shown)}
        >
          {busy ? (copy ? 'Copying…' : 'Moving…') : copy ? 'Copy' : 'Move'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// The address of a page or folder.
const addressOf = (spaceId: SpaceId, node: { id: FolderId | PageId; kind: 'folder' | 'page' }) =>
  node.kind === 'folder'
    ? ({
        to: '/s/$spaceId/f/$folderId',
        params: { spaceId, folderId: node.id as FolderId },
      } as const)
    : ({ to: '/s/$spaceId/p/$pageId', params: { spaceId, pageId: node.id as PageId } } as const);
